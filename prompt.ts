// =============================================================================
// All LLM-facing prompts for the iam plugin
// =============================================================================

export const TOOL_DESCRIPTION = `Inter-agent messaging. Use this to communicate with other parallel agents (task tools).

Actions:
- "announce": Announce what you're working on (do this first!). Shows all parallel agents. You can re-announce to update your status.
- "read": Read your messages (marks them as read)
- "broadcast": Send a message (requires 'message', optional 'to')`;

export const ARG_DESCRIPTIONS = {
  action: "Action to perform",
  to: "Recipient(s): 'agentA', 'agentA,agentC', or 'all' (default: all)",
  message: "Your announcement or message content",
} as const;

// =============================================================================
// Types
// =============================================================================

export interface ParallelAgent {
  alias: string;
  description?: string;
}

// =============================================================================
// Tool output messages
// =============================================================================

export function formatAgentList(agents: ParallelAgent[]): string[] {
  const lines: string[] = [];
  for (const agent of agents) {
    if (agent.description) {
      lines.push(`• ${agent.alias} is working on: ${agent.description}`);
    } else {
      lines.push(`• ${agent.alias} is running (hasn't announced yet)`);
    }
  }
  return lines;
}

export function readResult(
  alias: string,
  messages: { from: string; body: string; timestamp: number; read: boolean }[],
  unreadCount: number,
  hasAnnounced: boolean
): string {
  const lines = [`You are: ${alias}`, ``];

  if (messages.length === 0) {
    lines.push(`No messages in your inbox.`);
  } else {
    lines.push(`Your inbox (${unreadCount} were unread):`, `---`);

    for (const msg of messages) {
      const time = new Date(msg.timestamp).toISOString();
      const status = msg.read ? "" : " [NEW]";
      lines.push(`[${time}] From: ${msg.from}${status}`);
      lines.push(msg.body);
      lines.push(`---`);
    }

    lines.push(``);
    lines.push(`To reply: use action="broadcast" with to="<sender>" and message="..."`);
  }

  if (!hasAnnounced) {
    lines.push(``);
    lines.push(`IMPORTANT: You MUST use action="announce" to declare what you're working on before continuing.`);
  }

  return lines.join("\n");
}

export function announceResult(alias: string, parallelAgents: ParallelAgent[]): string {
  const lines = [
    `Announced! Other agents will see your description when they call announce.`,
    ``,
    `You are: ${alias}`,
  ];

  if (parallelAgents.length > 0) {
    lines.push(``);
    lines.push(`--- Parallel Agents ---`);
    lines.push(...formatAgentList(parallelAgents));
    lines.push(``);
    lines.push(`Use action="broadcast" to coordinate with them.`);
  } else {
    lines.push(``);
    lines.push(`No other agents running yet.`);
  }

  return lines.join("\n");
}

export const BROADCAST_MISSING_MESSAGE = `Error: 'message' parameter is required for action="broadcast".`;

export function broadcastUnknownRecipient(to: string, known: string[]): string {
  const list = known.length > 0 ? `Known agents: ${known.join(", ")}` : "No agents available yet.";
  return `Error: Unknown recipient "${to}". ${list}`;
}

export function broadcastResult(recipients: string[], messageId: string): string {
  const recipientStr = recipients.length === 1 ? recipients[0] : recipients.join(", ");
  return `Message sent!\n\nTo: ${recipientStr}\nMessage ID: ${messageId}\n\nRecipients will be notified.`;
}

export function unknownAction(action: string): string {
  return `Unknown action: ${action}. Valid actions: announce, read, broadcast`;
}

// =============================================================================
// System prompt injection
// =============================================================================

export const SYSTEM_PROMPT = `
<instructions tool="iam">
# Inter-Agent Messaging

You have access to an \`iam\` tool for communicating with other parallel agents.

Usage:
- action="announce", message="..." - Announce what you're working on (do this first!)
- action="read" - Read your messages
- action="broadcast", message="..." - Message all agents
- action="broadcast", to="agentA", message="..." - Message specific agent(s)

At the start of your task, use announce to let other agents know what you're doing.
You can re-announce to update your status as your task evolves.
Check your inbox when notified about new messages.

When you complete your task, broadcast to all: "Done. Here's what I found/did: ..."
</instructions>
`;

// =============================================================================
// Urgent notification injection
// =============================================================================

export function urgentNotification(unreadCount: number): string {
  return `<system-reminder priority="critical">
URGENT: You have ${unreadCount} unread message(s) in your IAM inbox.
Use the iam tool with action="read" NOW to check your messages before continuing other work.
</system-reminder>`;
}
