// =============================================================================
// All LLM-facing prompts for the Pocket Universe plugin
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Use 'send_to' for a specific agent, or omit to message all. Use 'reply_to' to reply (auto-wires recipient to sender).`;

export const SPAWN_DESCRIPTION = `Spawn a new sibling agent to work on a task in parallel. The new agent joins the network and can communicate via broadcast. Returns immediately (fire-and-forget). When the spawned agent completes, its output is piped to the caller.`;

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

export function spawnResult(
  spawnedAlias: string,
  sessionId: string,
  description: string,
): string {
  return `Spawned ${spawnedAlias} (session: ${sessionId})
Task: ${description}
The agent is now running in parallel and can be reached via broadcast.`;
}

export const SPAWN_NOT_CHILD_SESSION = `Error: spawn can only be called from a subagent session (a session with a parentID). Main sessions should use the 'task' tool directly.`;

export const SPAWN_MISSING_PROMPT = `Error: 'prompt' parameter is required.`;

// =============================================================================
// System prompt injection
// =============================================================================

import { isWorktreeEnabled, isSpawnEnabled } from "./config";

/**
 * Get the system prompt, dynamically including sections based on config.
 */
export function getSystemPrompt(): string {
  const sections: string[] = [];

  // Header
  sections.push(`<instructions tool="pocket-universe">
# Pocket Universe — Parallel Agent Orchestration

Use \`broadcast\` to communicate with other parallel agents.`);

  // Spawn intro (if enabled)
  if (isSpawnEnabled()) {
    sections.push(
      `Use \`spawn\` to create new sibling agents for parallel work.`,
    );
  }

  // Announce section
  sections.push(`
## IMPORTANT: Announce Yourself First
Your first action should be calling \`broadcast(message="what you're working on")\` to announce yourself. Until you do, other agents won't know your purpose.

**Status updates**: Calling \`broadcast(message="...")\` without \`send_to\` updates your status. This is passive visibility — other agents see your status history when they broadcast. Use status updates to track progress (e.g., "searching for X", "found X", "implementing Y"). Status updates do NOT send messages or wake other agents.`);

  // Worktree section (only if enabled)
  if (isWorktreeEnabled()) {
    sections.push(`
## Isolated Worktrees
Each agent operates in its own isolated git worktree - a clean checkout from the last commit.
- Your worktree path is shown in your system prompt (if available)
- **ALL file operations should use paths relative to or within your worktree**
- Do NOT modify files outside your assigned worktree
- Other agents have their own worktrees - coordinate via broadcast, don't touch their files`);
  }

  // Messaging section
  sections.push(`
## Sending Messages
- \`broadcast(message="...")\` → **status update** (visible to all, not a message)
- \`broadcast(send_to="agentB", message="...")\` → send message to specific agent
- \`broadcast(reply_to=1, message="...")\` → reply to message #1

**Important:** Broadcasting without \`send_to\` updates your status but does NOT queue a message. Use \`send_to\` for direct communication that needs a reply.`);

  // Spawn section (only if enabled)
  if (isSpawnEnabled()) {
    const spawnSection = isWorktreeEnabled()
      ? `
## Spawning Agents
- \`spawn(prompt="...", description="...")\` → create a sibling agent
- **Fire-and-forget**: spawn() returns immediately, you continue working
- **Output piping**: When spawned agent completes, its output arrives as a message
- Spawned agents get their own isolated worktrees`
      : `
## Spawning Agents
- \`spawn(prompt="...", description="...")\` → create a sibling agent
- **Fire-and-forget**: spawn() returns immediately, you continue working
- **Output piping**: When spawned agent completes, its output arrives as a message`;
    sections.push(spawnSection);
  }

  // Receiving messages section
  const agentExample = isWorktreeEnabled()
    ? `{ name: "agentA", status: "Working on X", worktree: "/path/to/.worktrees/agentA" }`
    : `{ name: "agentA", status: "Working on X" }`;

  const agentsDescription = isWorktreeEnabled()
    ? `- **agents**: Other agents, their status, and their worktree paths`
    : `- **agents**: Other agents and their current status`;

  sections.push(`
## Receiving Messages
Messages appear as synthetic \`broadcast\` tool results:
\`\`\`
{
  agents: [${agentExample}],
  messages: [{ id: 1, from: "agentA", content: "..." }]
}
\`\`\`

${agentsDescription}
- **messages**: Messages to reply to using \`reply_to\``);

  // Footer
  if (isSpawnEnabled()) {
    sections.push(`
When you receive output from a spawned agent, process it and incorporate the results.`);
  }

  sections.push(`</instructions>`);

  return sections.join("\n");
}

// Legacy export for backwards compatibility (but prefer getSystemPrompt())
export const SYSTEM_PROMPT = getSystemPrompt();
