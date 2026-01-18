export const SUBAGENT_DESCRIPTION = `Spawn a new sibling agent to work on a task in parallel. The new agent joins the IAM network and can communicate via broadcast. Returns immediately (fire-and-forget).`;

export function subagentResult(
  subagentAlias: string,
  sessionId: string,
  description: string,
): string {
  return `Spawned ${subagentAlias} (session: ${sessionId})
Task: ${description}
The agent is now running in parallel and can be reached via broadcast.`;
}

export const SUBAGENT_NOT_CHILD_SESSION = `Error: subagent can only be called from a subagent session (a session with a parentID). Main sessions should use the 'task' tool directly.`;

export const SUBAGENT_MISSING_PROMPT = `Error: 'prompt' parameter is required.`;

export const SUBAGENT_CREATE_FAILED = `Error: Failed to create session. No session ID returned.`;

export function subagentMaxDepth(depth: number, maxDepth: number): string {
  return `Error: Maximum subagent depth reached (${depth}/${maxDepth}). This session cannot spawn more subagents.`;
}

export function subagentError(error: string): string {
  return `Error: Failed to create subagent: ${error}`;
}

export function formatSubagentOutput(alias: string, output: string): string {
  // Strip task_metadata section if present (internal metadata, not for user display)
  const cleanOutput = output.replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\n*/g, '').trim();
  return `[${alias} completed]\n\n<output=${alias}>\n${cleanOutput}\n</output>`;
}

export function receivedSubagentOutput(alias: string, output: string): string {
  return `[Received ${alias} completed task]\n${output}`;
}
