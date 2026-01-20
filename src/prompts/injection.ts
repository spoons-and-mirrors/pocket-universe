// =============================================================================
// Injection prompts - messages injected into agent sessions
// =============================================================================

// =============================================================================
// TEMPLATES
// =============================================================================

const AGENT_COMPLETED_TEMPLATE = `Agent {{alias}} completed.`;

const AGENT_COMPLETED_WITH_SUMMARY_TEMPLATE = `Agent {{alias}} completed:
{{summary}}`;

const SUBAGENT_COMPLETED_SUMMARY_TEMPLATE = `Agent {{alias}} completed successfully.
Output was piped to the caller.`;

const SUBAGENT_RUNNING_TEMPLATE = `Subagent {{alias}} is running in parallel.`;

const SUBAGENT_TASK_OUTPUT_TEMPLATE = `Subagent {{alias}} is running.
Task: {{description}}`;

// =============================================================================
// SIMPLE CONSTANTS
// =============================================================================

export const ANNOUNCE_HINT = `Call broadcast(message='what you are working on') to announce yourself first.`;

export const POCKET_UNIVERSE_SUMMARY_HEADER = `[Pocket Universe Summary]`;
export const POCKET_UNIVERSE_AGENTS_INTRO = `The following agents completed their work:`;
export const WORKTREE_MERGE_NOTE = `Note: Agent changes are preserved in their worktrees. Review and merge as needed.`;

export const WORKTREE_SUMMARY_HEADER = `Active agent worktrees - each agent works in isolation`;
export const WORKTREE_SUMMARY_NOTE = `Changes made by agents are preserved in their worktrees. You may need to merge them.`;

// =============================================================================
// RENDER FUNCTIONS
// =============================================================================

export function agentCompletedMessage(alias: string): string {
  return AGENT_COMPLETED_TEMPLATE.replace('{{alias}}', alias);
}

export function agentCompletedWithSummary(alias: string, summary: string): string {
  return AGENT_COMPLETED_WITH_SUMMARY_TEMPLATE.replace('{{alias}}', alias).replace(
    '{{summary}}',
    summary,
  );
}

export function subagentCompletedSummary(alias: string): string {
  return SUBAGENT_COMPLETED_SUMMARY_TEMPLATE.replace('{{alias}}', alias);
}

export function subagentRunningMessage(alias: string): string {
  return SUBAGENT_RUNNING_TEMPLATE.replace('{{alias}}', alias);
}

export function subagentTaskOutput(alias: string, description: string): string {
  return SUBAGENT_TASK_OUTPUT_TEMPLATE.replace('{{alias}}', alias).replace(
    '{{description}}',
    description,
  );
}
