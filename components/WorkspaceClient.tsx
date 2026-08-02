"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CodePanel } from './CodePanel';
import { FileData, Message, StatusStep } from '@/types/workspace';
import ChatPanel from './ChatPanel';
import { MIN_CREDITS_TO_GENERATE } from '@/lib/constants';
import { toast } from 'sonner';

interface workspaceClientProps {
  initialPrompt: string | null;
  userCredits: number;
  userId: string;
  userPlan: string;
}

const WorkspaceClient = ({ initialPrompt, userCredits, userId, userPlan }: workspaceClientProps) => {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [credits, setCredits] = useState(userCredits);

  const [fileData, setFileData] = useState<FileData | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusLog, setStatusLog] = useState<StatusStep[]>([]);

  const messagesRef = useRef<Message[]>(messages);

useEffect(() => {
  messagesRef.current = messages;
}, [messages]);

const fileDataRef = useRef<FileData | null>(fileData);

useEffect(() => {
  fileDataRef.current = fileData;
}, [fileData]);

const workspaceIdRef = useRef<string | null>(workspaceId);

useEffect(() => {
  workspaceIdRef.current = workspaceId;
}, [workspaceId]);

  const handleFilePatch = useCallback((patches: FileData) => {
    setFileData(patches);
  }, []);

  const handleGenerate = useCallback(
    async (prompt: string, imageur?: string) => {
      if (isGenerating) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;

      const userMessage: Message = {
        role: "user",
        content: prompt,
        ...(imageUrl ? { imageUrl } : {}),
      };

      const currentMessages = messagesRef.current;
      const currentWorkspaceId = workspaceIdRef.current;

      setMessages((prev) => [...prev, userMessage]);
      setIsGenerating(true);
      setStatusLog([{ label: "Thinking…", status: "running" }]);

      try {
        const res = await fetch("/api/gen-ai-code", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId: currentWorkspaceId,
            userId,
            messages: [...currentMessages, userMessage],
            fileData: fileDataRef.current,
          }),
        });

        if (res.status === 402) {
        toast.error("Not enough credits.");

        setMessages((prev) => prev.slice(0, -1));

        return;
      }

      if (res.status === 429) {
        toast.error("Too many requests. Please slow down.");

        setMessages((prev) => prev.slice(0, -1));

        return;
      }

      if (!res.ok || !res.body) {
        throw new Error("Generation failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split("\n\n");

        // Example buffer after a few chunks might look like:
        //   "data: {...}\n\ndata: {...}\n\ndata: {inc"
        // After split:
        //   ["data: {...}", "data: {...}", "data: {inc"]

        buffer = lines.pop() ?? "";
      }
      } catch (error) {}
    }, 
    [credits, isGenerating, userId]);

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden bg-[#0a0a0a]">
        {/* Chat panel - left */}
        <ChatPanel
        messages={messages}
        isGenerating={isGenerating}
        isImproving={false}
        statusLog={statusLog}
        credits={credits}
        initialPrompt={initialPrompt}
        onGenerate={handleGenerate}
        userId={userId}
        workspaceId={workspaceId}
        appTitle={'Test Title'}
        />

        {/* Code panel - right */}
        <CodePanel fileData={fileData}
          isGenerating={isGenerating}
          statusLog={statusLog}
          onFilePatch={handleFilePatch} />
    </div>
  )
}

export default WorkspaceClient;