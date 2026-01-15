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

export function subagentError(error: string): string {
  return `Error: Failed to create subagent: ${error}`;
}

export function formatSubagentOutput(alias: string, output: string): string {
  return `[Subagent ${alias} completed]\n\n<agent_output from="${alias}">\n${output}\n</agent_output>`;
}

export function receivedSubagentOutput(alias: string, output: string): string {
  return `[Received ${alias} completed task]\n${output}`;
}
