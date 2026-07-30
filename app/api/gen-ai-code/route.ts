import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import { db } from "@/lib/prisma";
import { FileData, Message  } from "@/types/workspace";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;

  return [messages[0], ...messages.slice(-8)];
}

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GEN_AI_API_KEY });

function buildContents(messages: Message[], fileData: FileData | null){
  const trimmed = trimHistory(messages);

  return trimmed.map((msg, idx) => {
    const role = msg.role === "assistant" ? "model" : "user";

    if(msg.role === "user"){
      const parts: object[] = [];

      let text = msg.content;

      if (msg.imageUrl) {
        text = `[The user has attached an image. Use this URL directly in the generated app where relevant (as img src, background-image, etc.): ${msg.imageUrl}]\n\n${text}`;
      }

      const isLast = idx === trimmed.length - 1;

      if (isLast && fileData) {
        text +=
          "\n\nCurrent project files for context:\n" +
          JSON.stringify(fileData, null, 2);
      }

      parts.push({ text });

      return { role, parts };
    }
    return { role, parts: [{ text: msg.content }] };
  })
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert React developer. Your job is to generate complete, working React applications based on user prompts.

RULES:
1. Always respond with a valid JSON object — no markdown fences, no extra text.
2. The JSON must match this exact shape:
{
  "assistantMessage": "<brief explanation of what you built/changed>",
  "title": "<short 2-4 word title for the app, e.g. 'Todo List App'>",
  "files": {
    "/App.js": { "code": "<full file content>" },
    "/components/SomeComponent.js": { "code": "<full file content>" }
  },
  "dependencies": {
    "some-package": "latest"
  }
}
3. Use React (functional components + hooks). Do NOT use TypeScript in generated files.
4. Use Tailwind CSS for all styling. Do not use CSS modules or inline styles unless absolutely necessary.
5. The entry point must always be /App.js and must export a default component.
6. All imports must reference files you include in "files" or packages in "dependencies".
7. Do not include react, react-dom, or tailwindcss in "dependencies" — they are always available.
8. When modifying existing code, include ALL files (both changed and unchanged) in "files".
9. Keep code clean, readable, and production-quality.
10. If the user attaches an image, use it as a design reference and match the layout/style as closely as possible.`;


function extractThoughtLabel(text: string): string | null {
  // Try to grab **bold heading** at the start
  const boldMatch = text.match(/\*\*([^*]{4,60})\*\*/);

  if (boldMatch) {
    return boldMatch[1].trim();
  }

  // Fall back to first sentence (up to first . or \n), capped at 60 chars
  const sentence = text.split(/[.\n]/)[0].trim();

  if (sentence.length >= 8 && sentence.length <= 80) {
    return sentence;
  }

  return null;
}

function sseEvent(type: string, payload: unknown): string {
  return `data: ${JSON.stringify({
    type,
    ...(payload as object),
  })}\n\n`;
}

async function validateDependencies(
  deps: Record<string, string>,
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};

  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      try {
        const res = await fetch(
          `https://registry.npmjs.org/${pkg}/latest`,
          {
            signal: AbortSignal.timeout(1500),
          }
        );

        if (res.ok) {
          valid[pkg] = version;
        }
      } catch {
        // Silently skip hallucinated packages
      }
    })
  );

  return valid;
}

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return Response.json(
      { message: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json();

  const { workspaceId, userId, messages, fileData } = body as {
    workspaceId: string | null;
    userId: string;
    messages: Message[];
    fileData: FileData | null;
  };

  if (!messages?.length) {
    return Response.json(
        { message: "No messages provided" },
        { status: 400 }
    );
  }

// ── Arcjet: rate limit, prompt injection, sensitive info ───────────────────────

  const user = await db.user.findUnique({
    where: {
        id: userId,
        clerkId,
    },
    select: {
        id: true,
        credits: true,
    },
  });

    if (!user) {
        return Response.json(
            { message: "User not found" },
            { status: 404 }
        );
    }

    if (user.credits < CREDIT_COST_PER_GENERATION) {
        return Response.json(
            { message: "Insufficient credits" },
            { status: 402 },
        );
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
          const enqueue = async (chunk: string) => {
            controller.enqueue(encoder.encode(chunk));

            try{
              const contents = buildContents(messages, fileData);
              
              const geminiStream = await ai.models.generateContentStream({
                model: "gemini-3.5-flash",
                contents,
                config: {
                  systemInstruction: SYSTEM_PROMPT,
                  temperature: 0.7,

                  // Force JSON output — Gemini will never wrap the response in markdown
                  responseMimeType: "application/json",

                  thinkingConfig: {
                    // Gemini emits thought chunks before the actual output.
                    // We extract short labels from them and emit as status events
                    // so the user sees "Designing layout…", "Adding interactivity…" etc.
                    includeThoughts: true,
                  },
                },
              });

              let accumulated = ""; // Collects the actual JSON output chunks
              let lastEmitTime = 0; // used to throttle thought -> status emissions

              for await (const chunk of geminiStream) {
                const parts = chunk.candidates?.[0]?.content?.parts ?? [];

                for (const part of parts) {
                  if (!part.text) continue;

                  if (part.thought) {
                    // Thought chunks are Gemini's internal reasoning — verbose and frequent.
                    // We throttle to one status update per 600ms and extract just the
                    // bold heading or first sentence so the UI stays clean.
                    const now = Date.now();

                    if (now - lastEmitTime > 600) {
                      const label = extractThoughtLabel(part.text);

                      if (label) {
                        enqueue(sseEvent("status", { message: label }));
                        lastEmitTime = now;
                      }
                      else{
                        // Non-thought parts are the actual JSON output - accumulate them
                        accumulated += part.text;
                      }
                    }
                  }
                }
              }

              // ── Parse JSON ───────────────────────────────────────────────────────────────
              // If Gemini returns malformed JSON we abort here without deducting a credit.
              // This is the "no charge on AI failure" guarantee.

              let parsed: {
                assistantMessage: string;
                title?: string;
                files: Record<string, { code: string }>;
                dependencies: Record<string, string>;
              };

              try {
                // Parse Gemini response here
                parsed = JSON.parse(accumulated);
              } catch (error) {
                // Handle malformed JSON here
                enqueue(sseEvent("error", { message: "AI returned malformed JSON. Please try again." }));
                controller.close();
                return;
              }

              const {
                assistantMessage,
                title: aiTitle,
                files,
                dependencies,
              } = parsed;

              if (!files || typeof files !== "object") {
                enqueue(
                  sseEvent("error", {
                    message: "AI response missing files. Please try again.",
                  })
                );
                controller.close();
                return;
              }

              // ── Validate npm packages ────────────────────────────────────────────────────
              // Gemini sometimes hallucinates package names that don't exist on npm.
              // We hit the npm registry for each dep and silently drop any fakes.
              // Real packages pass through unchanged.

              enqueue(sseEvent("status", { message: "Validating packages…" }));
              const validatedDeps = await validateDependencies(dependencies ?? {});
              const newFileData: FileData = {
                files,
                dependencies: validatedDeps,
                title: aiTitle,
              }

            }catch (error) {}
          };
        },
    });
}