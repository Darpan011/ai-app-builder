import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import React from 'react'
import WorkspaceClient from '@/components/WorkspaceClient';

interface WorkspacePageProps {
  searchParams: Promise<{ prompt?: string; id?: string }>;
}

const WorkspacePage = async ({ searchParams }: WorkspacePageProps) => {

  const { userId } = await auth();
  if(!userId) redirect("/");

  const { prompt, id } = await searchParams;

  let workspace = null;

  return (
    <WorkspaceClient 
      initialPrompt={prompt ?? null}
      userCredits={10} //Placeholder until db reads till step 8
      userId={userId}
      userPlan={"free"} //Placeholder until db reads till step 8
      workspace={workspace}
    />
  )
}

export default WorkspacePage