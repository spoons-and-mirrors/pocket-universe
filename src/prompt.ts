// =============================================================================
// All LLM-facing prompts for the Pocket Universe plugin
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Use 'send_to' for a specific agent, or omit to message all. Use 'reply_to' to reply (auto-wires recipient to sender).`;

export const SUBAGENT_DESCRIPTION = `Spawn a new sibling agent to work on a task in parallel. The new agent joins the IAM network and can communicate via broadcast. Returns immediately (fire-and-forget).`;

// =============================================================================
// Types
// =============================================================================

export interface ParallelAgent {
  alias: string;
  description?: string[]; // Status history (most recent last)
  worktree?: string; // Isolated working directory path
}

export interface HandledMessage {
  id: number;
  from: string;
  body: string;
}

// =============================================================================
// Tool output messages
// =============================================================================

export function broadcastResult(
  alias: string,
  recipients: string[],
  parallelAgents: ParallelAgent[],
  handledMessage?: HandledMessage,
): string {
  const lines: string[] = [];

  // Identity first
  lines.push(`You are: ${alias}`);
  lines.push(``);

  // AGENTS LIST AT THE TOP - most important info
  if (parallelAgents.length > 0) {
    lines.push(`Available agents:`);
    for (const agent of parallelAgents) {
      let agentLine = `  - ${agent.alias}`;
      if (agent.worktree) {
        agentLine += ` [worktree: ${agent.worktree}]`;
      }
      lines.push(agentLine);

      // Show status history (most recent last)
      if (agent.description && agent.description.length > 0) {
        for (const status of agent.description) {
          lines.push(`      → ${status}`);
        }
      }
    }
  } else {
    lines.push(`No other agents available yet.`);
  }

  // Combined reply confirmation (when using reply_to)
  // Include FULL source message for audit trail
  if (handledMessage) {
    lines.push(``);
    lines.push(`Replied to #${handledMessage.id} from ${handledMessage.from}:`);
    lines.push(`  "${handledMessage.body}"`);
  } else if (recipients.length > 0) {
    // Regular message (no reply_to)
    lines.push(``);
    const recipientStr =
      recipients.length === 1 ? recipients[0] : recipients.join(", ");
    lines.push(`Message sent to: ${recipientStr}`);
  }

  return lines.join("\n");
}

export const BROADCAST_MISSING_MESSAGE = `Error: 'message' parameter is required.`;

export const BROADCAST_SELF_MESSAGE = `Warning: You cannot send a message to yourself. The target alias is your own alias. Choose a different recipient.`;

export function broadcastUnknownRecipient(
  recipient: string,
  known: string[],
): string {
  const list =
    known.length > 0
      ? `Known agents: ${known.join(", ")}`
      : "No agents available yet.";
  return `Error: Unknown recipient "${recipient}". ${list}`;
}

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

// =============================================================================
// Resume/Broadcast prompts
// =============================================================================

/** Used to notify an agent that a new message arrived (duplicate removed from messaging.ts + index.ts) */
export function resumeBroadcastPrompt(senderAlias: string): string {
  return `[Broadcast from ${senderAlias}]: New message received. Check your inbox.`;
}

// =============================================================================
// Inbox injection prompts (from injection.ts)
// =============================================================================

export const ANNOUNCE_HINT = `Call broadcast(message='what you are working on') to announce yourself first.`;

// =============================================================================
// Agent completion prompts (from injection.ts)
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
// Pocket Universe Summary prompts (from injection.ts)
// =============================================================================

export const POCKET_UNIVERSE_SUMMARY_HEADER = `[Pocket Universe Summary]`;
export const POCKET_UNIVERSE_AGENTS_INTRO = `The following agents completed their work:`;
export const WORKTREE_MERGE_NOTE = `Note: Agent changes are preserved in their worktrees. Review and merge as needed.`;

// =============================================================================
// Subagent output prompts (from messaging.ts and tools.ts)
// =============================================================================

export function formatSubagentOutput(alias: string, output: string): string {
  return `[Subagent ${alias} completed]\n\n<agent_output from="${alias}">\n${output}\n</agent_output>`;
}

export function receivedSubagentOutput(alias: string, output: string): string {
  return `[Received ${alias} completed task]\n${output}`;
}

// =============================================================================
// Parent notification prompts (from tools.ts)
// =============================================================================

export function parentNotifyMessage(alias: string, message: string): string {
  return `[Pocket Universe] Message from ${alias}: ${message}`;
}

// =============================================================================
// Subagent error prompts (from tools.ts)
// =============================================================================

export const SUBAGENT_CREATE_FAILED = `Error: Failed to create session. No session ID returned.`;

export function subagentError(error: string): string {
  return `Error: Failed to create subagent: ${error}`;
}

// =============================================================================
// Recall tool prompts (from tools.ts and state.ts)
// =============================================================================

export const RECALL_DESCRIPTION = `Recall the history and status of agents in this Pocket Universe.

Use this to learn what previous agents accomplished, even if they completed before you started.

- Call with no parameters to get all agents' status histories
- Call with agent_name to get a specific agent's history
- Call with agent_name AND show_output=true to also see their final output

Output is only shown when requesting a specific agent with show_output=true.`;

export function recallNotFound(agentName: string): string {
  return `No agent found with name '${agentName}'.`;
}

export const RECALL_EMPTY = `No agents in history yet.`;

export const RECALL_AGENT_ACTIVE = `[Agent is still active - no output yet]`;
export const RECALL_AGENT_IDLE_NO_OUTPUT = `[Agent is idle but has not produced output yet]`;

// =============================================================================
// Worktree system prompt (from index.ts)
// =============================================================================

export function getWorktreeSystemPrompt(worktreePath: string): string {
  return `
<worktree>
Your isolated working directory: ${worktreePath}
ALL file operations (read, write, edit, bash) should use paths within this directory.
Do NOT modify files outside this worktree.
</worktree>
`;
}

// =============================================================================
// Worktree summary prompts (from injection.ts)
// =============================================================================

export const WORKTREE_SUMMARY_HEADER = `Active agent worktrees - each agent works in isolation`;
export const WORKTREE_SUMMARY_NOTE = `Changes made by agents are preserved in their worktrees. You may need to merge them.`;

// =============================================================================
// Task injection prompts (from injection.ts)
// =============================================================================

export function subagentTaskOutput(
  alias: string,
  description: string,
  sessionId: string,
): string {
  return `Subagent ${alias} is running.\nTask: ${description}\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
}

// =============================================================================
// System prompt injection
// =============================================================================

import {
  isWorktreeEnabled,
  isSubagentEnabled,
  isRecallEnabled,
} from "./config";

// =============================================================================
// Conditional Sections
// =============================================================================

const SECTION_SUBAGENT_INTRO = `Use \`subagent\` to create new sibling agents for parallel work.`;

const SECTION_WORKTREE = `
## Isolated Worktrees
Each agent operates in its own isolated git worktree - a clean checkout from the last commit.
- Your worktree path is shown in your system prompt (if available)
- **ALL file operations should use paths relative to or within your worktree**
- Do NOT modify files outside your assigned worktree
- Other agents have their own worktrees - coordinate via broadcast, don't touch their files`;

const SECTION_SUBAGENT = `
## Spawning Agents
- \`subagent(prompt="...", description="...")\` → create a sibling agent
- **Fire-and-forget**: subagent() returns immediately, you continue working
- **Output piping**: When subagent completes, its output arrives as a message`;

const SECTION_SUBAGENT_WORKTREE_NOTE = `
- Subagents get their own isolated worktrees`;

const SECTION_RECALL = `
## Querying Agent History
Use \`recall()\` to see all agents and their status history. Use \`recall(agent_name="X", show_output=true)\` to retrieve a completed agent's final output.`;

const SECTION_SUBAGENT_FOOTER = `
When you receive output from a subagent, process it and incorporate the results.`;

// =============================================================================
// Template
// =============================================================================

/**
 * Get the system prompt, dynamically including sections based on config.
 */
export function getSystemPrompt(): string {
  const worktree = isWorktreeEnabled();
  const subagent = isSubagentEnabled();
  const recall = isRecallEnabled();

  // Dynamic content based on worktree config
  const agentExample = worktree
    ? `{ name: "agentA", status: "Working on X", worktree: "/path/to/.worktrees/agentA" }`
    : `{ name: "agentA", status: "Working on X" }`;

  const agentsDescription = worktree
    ? `- **agents**: Other agents, their status, and their worktree paths`
    : `- **agents**: Other agents and their current status`;

  return `<instructions tool="pocket-universe">
# Pocket Universe — Parallel Agent Orchestration

Use \`broadcast\` to communicate with other parallel agents.
${subagent ? `${SECTION_SUBAGENT_INTRO}` : ""}

## IMPORTANT: Announce Yourself First
Your first action should be calling \`broadcast(message="what you're working on")\` to announce yourself. Until you do, other agents won't know your purpose.

**Status updates**: Calling \`broadcast(message="...")\` without \`send_to\` updates your status. This is passive visibility — other agents see your status history when they broadcast. Use status updates to track progress (e.g., "searching for X", "found X", "implementing Y"). Status updates do NOT send messages or wake other agents.${worktree ? SECTION_WORKTREE : ""}

## Sending Messages
- \`broadcast(message="...")\` → **status update** (visible to all, not a message)
- \`broadcast(send_to="agentB", message="...")\` → send message to specific agent
- \`broadcast(reply_to=1, message="...")\` → reply to message #1

**Important:** Broadcasting without \`send_to\` updates your status but does NOT queue a message. Use \`send_to\` for direct communication that needs a reply.${subagent ? `${SECTION_SUBAGENT}${worktree ? SECTION_SUBAGENT_WORKTREE_NOTE : ""}` : ""}${recall ? SECTION_RECALL : ""}

## Receiving Messages
Messages appear as synthetic \`broadcast\` tool results:
\`\`\`
{
  agents: [${agentExample}],
  messages: [{ id: 1, from: "agentA", content: "..." }]
}
\`\`\`

${agentsDescription}
- **messages**: Messages to reply to using \`reply_to\`${subagent ? SECTION_SUBAGENT_FOOTER : ""}
</instructions>`;
}

// Legacy export for backwards compatibility (but prefer getSystemPrompt())
export const SYSTEM_PROMPT = getSystemPrompt();
