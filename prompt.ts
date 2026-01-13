// =============================================================================
// All LLM-facing prompts for the iam plugin
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Use 'recipient' for specific agent(s), or omit to message all. Use 'reply_to' to mark messages as handled.`;

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
  handledMessages: HandledMessage[],
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

  // Show handled messages
  if (handledMessages.length > 0) {
    lines.push(``);
    lines.push(`Marked as handled: ${handledMessages.length} message(s)`);
    for (const msg of handledMessages) {
      const preview =
        msg.body.length > 80 ? msg.body.substring(0, 80) + "..." : msg.body;
      lines.push(`  #${msg.id} from ${msg.from}: "${preview}"`);
    }
  }

  return lines.join("\n");
}

export const BROADCAST_MISSING_MESSAGE = `Error: 'message' parameter is required.`;

export const BROADCAST_SELF_MESSAGE = `Warning: You cannot send a message to yourself. The target alias is your own alias. Choose a different recipient.`;

export function broadcastMessageTooLong(
  length: number,
  maxLength: number,
): string {
  return `Error: Message too long (${length} chars). Maximum allowed: ${maxLength} chars.`;
}

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
Incoming messages appear as \`broadcast\` tool results with a \`messages\` array:
\`\`\`
{ messages: [{ id: 1, from: "agentA", body: "..." }, ...] }
\`\`\`

Use \`reply_to\` to mark messages as handled (they persist until you do):
- \`broadcast(recipient="agentA", reply_to=[1], message="...")\`
- \`broadcast(recipient="agentA", reply_to=[1, 2, 3], message="...")\`
</instructions>
`;
