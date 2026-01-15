// =============================================================================
// Injection prompts
// =============================================================================

export const ANNOUNCE_HINT = `Call broadcast(message='what you are working on') to announce yourself first.`;

// =============================================================================
// Agent completion prompts
// =============================================================================

export function agentCompletedMessage(
  alias: string,
  sessionId?: string,
): string {
  if (sessionId) {
    return `Agent ${alias} completed.\nSession: ${sessionId}`;
  }
  return `Agent ${alias} completed.`;
}

export function agentCompletedWithSummary(
  alias: string,
  summary: string,
  sessionId: string,
): string {
  return `Agent ${alias} completed:\n${summary}\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
}

export function subagentCompletedSummary(
  alias: string,
  sessionId: string,
): string {
  return `Agent ${alias} completed successfully.\nOutput was piped to the caller.\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
}

export function subagentRunningMessage(
  alias: string,
  sessionId: string,
): string {
  return `Subagent ${alias} is running in parallel.\nSession: ${sessionId}`;
}

export function wrapTaskMetadata(sessionId: string): string {
  return `\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
}

export function taskOutputWithMetadata(
  text: string,
  sessionId: string,
): string {
  return text + wrapTaskMetadata(sessionId);
}

// =============================================================================
// Pocket Universe Summary prompts
// =============================================================================

export const POCKET_UNIVERSE_SUMMARY_HEADER = `[Pocket Universe Summary]`;
export const POCKET_UNIVERSE_AGENTS_INTRO = `The following agents completed their work:`;
export const WORKTREE_MERGE_NOTE = `Note: Agent changes are preserved in their worktrees. Review and merge as needed.`;

// =============================================================================
// Worktree summary prompts
// =============================================================================

export const WORKTREE_SUMMARY_HEADER = `Active agent worktrees - each agent works in isolation`;
export const WORKTREE_SUMMARY_NOTE = `Changes made by agents are preserved in their worktrees. You may need to merge them.`;

// =============================================================================
// Task injection prompts
// =============================================================================

export function subagentTaskOutput(
  alias: string,
  description: string,
  sessionId: string,
): string {
  return `Subagent ${alias} is running.\nTask: ${description}\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
}
