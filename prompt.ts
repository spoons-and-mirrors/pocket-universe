// =============================================================================
// All LLM-facing prompts for the iam plugin
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Use 'recipient' for a specific agent, or omit to message all. Use 'reply_to' to reply (auto-wires recipient to sender).`;

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
    lines.push(`Available agents to message:`);
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

  // Message confirmation
  if (recipients.length > 0) {
    lines.push(``);
    const recipientStr =
      recipients.length === 1 ? recipients[0] : recipients.join(", ");
    lines.push(`Message sent to: ${recipientStr}`);
  }

  // Show handled message
  if (handledMessage) {
    lines.push(``);
    const preview =
      handledMessage.body.length > 80
        ? handledMessage.body.substring(0, 80) + "..."
        : handledMessage.body;
    lines.push(
      `Marked as handled: #${handledMessage.id} from ${handledMessage.from}`,
    );
    lines.push(`  "${preview}"`);
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

// =============================================================================
// System prompt injection
// =============================================================================

export const SYSTEM_PROMPT = `
<instructions tool="iam">
# Inter-Agent Messaging

Use \`broadcast\` to communicate with other parallel agents.

## IMPORTANT: Broadcast Immediately on Start
Call \`broadcast(message="...")\` as your FIRST action to announce yourself and discover other agents. The tool result will show all available agents you can message.

## Sending Messages
- \`broadcast(message="...")\` → send to all agents
- \`broadcast(recipient="agentB", message="...")\` → send to specific agent

## Receiving Messages
Incoming messages appear as synthetic \`broadcast\` tool results:
\`\`\`
{
  agents: [{ name: "agentA", status: "Working on X" }],
  messages: [{ id: 1, from: "agentA", content: "..." }]
}
\`\`\`

- **agents**: Status announcements (not replyable)
- **messages**: Messages you can reply to using \`reply_to\`

Use \`reply_to\` to reply to a message (auto-wires recipient):
- \`broadcast(reply_to=1, message="...")\` → replies to message #1
</instructions>
`;
