import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import { db } from "@/lib/prisma";
import { FileData, Message  } from "@/types/workspace";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

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
          const enqueue = (chunk: string) => {
            controller.enqueue(encoder.encode(chunk));

            try{
              const contents = buildContents(messages, fileData);
            }catch (error) {}
          };
        },
    });
}