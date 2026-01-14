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
  description?: string;
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
      if (agent.description) {
        lines.push(`  - ${agent.alias}: ${agent.description}`);
      } else {
        lines.push(`  - ${agent.alias}`);
      }
    }
  } else {
    lines.push(`No other agents available yet.`);
  }

  // Combined reply confirmation (when using reply_to)
  if (handledMessage) {
    lines.push(``);
    const preview =
      handledMessage.body.length > 80
        ? handledMessage.body.substring(0, 80) + "..."
        : handledMessage.body;
    lines.push(`Replied to #${handledMessage.id} from ${handledMessage.from}:`);
    lines.push(`  "${preview}"`);
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

export const SYSTEM_PROMPT = `
<instructions tool="pocket-universe">
# Pocket Universe — Parallel Agent Orchestration

Use \`broadcast\` to communicate with other parallel agents.
Use \`spawn\` to create new sibling agents for parallel work.

## IMPORTANT: Announce Yourself First
Your first action should be calling \`broadcast(message="what you're working on")\` to announce yourself. Until you do, other agents won't know your purpose.

## Sending Messages
- \`broadcast(message="...")\` → announce yourself or send to all agents
- \`broadcast(send_to="agentB", message="...")\` → send to specific agent
- \`broadcast(reply_to=1, message="...")\` → reply to message #1

## Spawning Agents
- \`spawn(prompt="...", description="...")\` → create a sibling agent
- **Fire-and-forget**: spawn() returns immediately, you continue working
- **Output piping**: When spawned agent completes, its output arrives as a message
- The main session waits for all spawns to complete before continuing

## Receiving Messages
Messages appear as synthetic \`broadcast\` tool results:
\`\`\`
{
  agents: [{ name: "agentA", status: "Working on X" }],
  messages: [{ id: 1, from: "agentA", content: "..." }]
}
\`\`\`

- **agents**: Other agents and their current status
- **messages**: Messages to reply to using \`reply_to\`

When you receive output from a spawned agent, process it and incorporate the results.
</instructions>
`;
