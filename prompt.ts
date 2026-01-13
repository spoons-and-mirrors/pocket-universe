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

export interface InboxMessage {
  id: number; // Numeric ID for easy reference
  from: string;
  body: string;
  timestamp: number;
}

// =============================================================================
// Tool output messages
// =============================================================================

export function broadcastResult(
  alias: string,
  recipients: string[],
  parallelAgents: ParallelAgent[],
  handledCount: number,
): string {
  const lines: string[] = [];

  // Always show identity
  lines.push(`YOUR ALIAS: ${alias}`);
  lines.push(`(Do NOT use "${alias}" as the "recipient" target - that's YOU!)`);
  lines.push(``);

  // Show message confirmation
  if (recipients.length > 0) {
    const recipientStr =
      recipients.length === 1 ? recipients[0] : recipients.join(", ");
    lines.push(`Message sent to: ${recipientStr}`);
  }

  // Show handled confirmation
  if (handledCount > 0) {
    lines.push(`Marked ${handledCount} message(s) as handled.`);
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
    `To respond: broadcast(recipient="<agent>", reply_to="<ids>", message="...")`,
  );
  lines.push(
    `Use reply_to to mark messages as handled (e.g., reply_to="1,2" or reply_to="1")`,
  );

  return lines.join("\n");
}

// =============================================================================
// System prompt injection
// =============================================================================

export const SYSTEM_PROMPT = `
<instructions tool="iam">
# Inter-Agent Messaging

You have access to the \`broadcast\` tool for communicating with other parallel agents.

## Usage

\`\`\`
broadcast(message="...")                           # Send to all agents
broadcast(recipient="agentA", message="...")       # Send to specific agent
broadcast(recipient="agentA,agentC", message="...") # Send to multiple agents
broadcast(reply_to="1,2", message="...")           # Mark messages #1 and #2 as handled
\`\`\`

## Inbox Messages

When other agents message you, you'll see an "iam_inbox" tool result listing all pending messages with numeric IDs.
These messages persist until you mark them as handled using the \`reply_to\` parameter.

## Handling Messages

When you respond to or acknowledge a message, include its ID in \`reply_to\` to remove it from your inbox:
- \`broadcast(recipient="agentA", reply_to="1", message="Here's my answer...")\`
- \`broadcast(reply_to="1,2,3", message="Acknowledged all")\`

Messages you don't reply_to will keep appearing in your inbox on every turn.

## Best Practices

1. Always check your inbox for pending messages
2. Use reply_to to mark messages as handled after responding
3. When done with your task, broadcast a summary to all agents
</instructions>
`;
