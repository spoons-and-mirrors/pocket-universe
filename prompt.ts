// =============================================================================
// All LLM-facing prompts for the iam plugin
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Your first broadcast sets your status visible to others - make it a clear summary of your task. Use 'recipient' for specific agent(s), or omit to message all. Use 'reply_to' to mark messages as handled.`;

// =============================================================================
// Types
// =============================================================================

export interface ParallelAgent {
  alias: string;
  description?: string;
}

export interface InboxMessage {
  id: number; // Numeric ID for easy reference
  from: string;
  body: string;
  timestamp: number;
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

  // Always show identity with self-warning
  lines.push(`YOUR ALIAS: ${alias}`);
  lines.push(`(Do NOT use "${alias}" as recipient - that's you!)`);
  lines.push(``);

  // Show message confirmation
  if (recipients.length > 0) {
    const recipientStr =
      recipients.length === 1 ? recipients[0] : recipients.join(", ");
    lines.push(`Message sent to: ${recipientStr}`);
  }

  // Show handled messages with their content (so LLM knows what it replied to)
  if (handledMessages.length > 0) {
    lines.push(``);
    lines.push(`--- Replied to ${handledMessages.length} message(s) ---`);
    for (const msg of handledMessages) {
      const preview =
        msg.body.length > 80 ? msg.body.substring(0, 80) + "..." : msg.body;
      lines.push(`#${msg.id} from ${msg.from}: "${preview}"`);
    }
  }

  // Show other agents
  lines.push(``);
  if (parallelAgents.length > 0) {
    lines.push(`--- Other Agents ---`);
    for (const agent of parallelAgents) {
      if (agent.description) {
        lines.push(`- ${agent.alias}: ${agent.description}`);
      } else {
        lines.push(`- ${agent.alias}`);
      }
    }
  } else {
    lines.push(`No other agents registered yet.`);
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
// Inbox message bundle (injected into context)
// =============================================================================

export function buildInboxContent(messages: InboxMessage[]): string {
  const lines: string[] = [];

  lines.push(`📨 INCOMING MESSAGES (${messages.length}) 📨`);
  lines.push(``);

  for (const msg of messages) {
    lines.push(`--- Message #${msg.id} from ${msg.from} ---`);
    lines.push(msg.body);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(
    `Reply: broadcast(recipient="<sender>", reply_to="<id>", message="...")`,
  );

  return lines.join("\n");
}

// =============================================================================
// System prompt injection
// =============================================================================

export const SYSTEM_PROMPT = `
<instructions tool="iam">
# Inter-Agent Messaging

Use \`broadcast\` to communicate with other parallel agents.

## First Broadcast = Your Status
Your first broadcast message becomes your permanent status visible to all other agents.
Make it a clear, descriptive summary of your GLOBAL task (e.g., "Implementing auth middleware and JWT validation" not just "Starting work").

## Sending Messages
- \`broadcast(message="...")\` → send to all agents
- \`broadcast(recipient="agentB", message="...")\` → send to specific agent

## Receiving Messages
Incoming messages appear as an \`iam_inbox\` tool result with numbered messages.
Use \`reply_to\` to mark messages as handled and remove them from your inbox:
- \`broadcast(recipient="agentA", reply_to="1", message="...")\`

Unhandled messages persist until you reply_to them.
</instructions>
`;
