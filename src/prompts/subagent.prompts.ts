// =============================================================================
// Subagent tool prompts
// =============================================================================

import { render } from './render';

// =============================================================================
// TEMPLATES
// =============================================================================

// =============================================================================
// TOOL DESCRIPTION
// =============================================================================

export const SUBAGENT_DESCRIPTION = `Spawn a new sibling agent to work on a task in parallel. The new agent joins the IAM network and can communicate via broadcast. Returns immediately (fire-and-forget).`;

const SUBAGENT_RESULT_TEMPLATE = `Spawned {{alias}} (session: {{sessionId}})
Task: {{description}}
The agent is now running in parallel and can be reached via broadcast.`;

const SUBAGENT_MAX_DEPTH_TEMPLATE = `Error: Maximum subagent depth reached ({{depth}}/{{maxDepth}}). This session cannot spawn more subagents.`;

const SUBAGENT_ERROR_TEMPLATE = `Error: Failed to create subagent: {{error}}`;

const FORMAT_SUBAGENT_OUTPUT_TEMPLATE = `[{{alias}} completed]

<output={{alias}}>
{{output}}
</output>`;

const RECEIVED_SUBAGENT_OUTPUT_TEMPLATE = `[Received {{alias}} completed task]
{{output}}`;

// =============================================================================
// ERROR MESSAGES
// =============================================================================

export const SUBAGENT_NOT_CHILD_SESSION = `Error: subagent can only be called from a subagent session (a session with a parentID). Main sessions should use the 'task' tool directly.`;

export const SUBAGENT_MISSING_PROMPT = `Error: 'prompt' parameter is required.`;

export const SUBAGENT_CREATE_FAILED = `Error: Failed to create session. No session ID returned.`;

// =============================================================================
// RENDER FUNCTIONS
// =============================================================================

export function subagentResult(
  subagentAlias: string,
  sessionId: string,
  description: string,
): string {
  return render(SUBAGENT_RESULT_TEMPLATE, {
    alias: subagentAlias,
    sessionId,
    description,
  });
}

export function subagentMaxDepth(depth: number, maxDepth: number): string {
  return render(SUBAGENT_MAX_DEPTH_TEMPLATE, {
    depth: String(depth),
    maxDepth: String(maxDepth),
  });
}

export function subagentError(error: string): string {
  return render(SUBAGENT_ERROR_TEMPLATE, { error });
}

export function formatSubagentOutput(alias: string, output: string): string {
  return render(FORMAT_SUBAGENT_OUTPUT_TEMPLATE, { alias, output: output.trim() });
}

export function receivedSubagentOutput(alias: string, output: string): string {
  return render(RECEIVED_SUBAGENT_OUTPUT_TEMPLATE, { alias, output });
}
