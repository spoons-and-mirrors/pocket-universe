// =============================================================================
// All LLM-facing prompts for the iam plugin
// =============================================================================

export const TOOL_DESCRIPTION = `Inter-agent messaging. Use this to communicate with other parallel agents (task tools).

Actions:
- "sessions": Show agents you can message (e.g., agentA, agentB)
- "read": Read all your messages (marks them as read)
- "write": Send a message (requires 'to' and 'message' parameters)
- "announce": Announce what you're working on (requires 'message' parameter)`;

export const ARG_DESCRIPTIONS = {
  action: "Action to perform",
  to: "Recipient agent name, e.g. 'agentA' (required for 'write')",
  message: "Message content (required for 'write'), or self-description (required for 'announce')",
} as const;

// =============================================================================
// Tool output messages
// =============================================================================

export const SESSIONS_EMPTY = `No other agents available yet.

Agents will appear here when:
- Parallel tasks are spawned by the same parent
- Another agent sends you a message`;

export function sessionsResult(agents: {alias: string; description?: string}[]): string {
  const lines = [`Agents you can message:\n`]
  for (const agent of agents) {
    if (agent.description) {
      lines.push(`- ${agent.alias}: ${agent.description}`)
    } else {
      lines.push(`- ${agent.alias}`)
    }
  }
  lines.push(``)
  lines.push(`To send: use action="write" with to="<agent>" and message="..."`)
  return lines.join("\n")
}

export const READ_EMPTY = `No messages in your IAM inbox.`;

export function readResult(
  messages: {from: string; body: string; timestamp: number; read: boolean}[],
  unreadCount: number
): string {
  const lines = [`Your IAM inbox (${unreadCount} were unread):\n`, `---`];

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toISOString();
    const status = msg.read ? "" : " [NEW]";
    lines.push(`[${time}] From: ${msg.from}${status}`);
    lines.push(msg.body);
    lines.push(`---`);
  }

  lines.push(``);
  lines.push(
    `To reply: use action="write" with to="<sender>" and message="..."`
  );

  return lines.join("\n");
}

export const WRITE_MISSING_TO = `Error: 'to' parameter is required for action="write".`;
export const WRITE_MISSING_MESSAGE = `Error: 'message' parameter is required for action="write".`;
export const ANNOUNCE_MISSING_MESSAGE = `Error: 'message' parameter is required for action="announce". Describe what you're working on.`;

export interface ParallelAgent {
  alias: string;
  description?: string;
}

export function announceResult(alias: string, parallelAgents: ParallelAgent[]): string {
  const lines = [`Announced! Other agents will see your description when they list sessions.`, ``, `You are: ${alias}`];
  
  if (parallelAgents.length > 0) {
    lines.push(``);
    lines.push(`--- Parallel Agents ---`);
    for (const agent of parallelAgents) {
      if (agent.description) {
        lines.push(`• ${agent.alias} is working on: ${agent.description}`);
      } else {
        lines.push(`• ${agent.alias} is running (hasn't announced yet)`);
      }
    }
    lines.push(``);
    lines.push(`Use action="write" to coordinate with them if needed.`);
  }
  
  return lines.join("\n");
}

export function writeUnknownRecipient(to: string, known: string[]): string {
  const list =
    known.length > 0
      ? `Known agents: ${known.join(", ")}`
      : "No agents available yet.";
  return `Error: Unknown recipient "${to}". ${list}`;
}

export function writeResult(to: string, messageId: string): string {
  return `Message sent!\n\nTo: ${to}\nMessage ID: ${messageId}\n\nThe recipient will be notified.`;
}

export function unknownAction(action: string): string {
  return `Unknown action: ${action}`;
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
- action="sessions" - See other agents and what they're working on
- action="read" - Read your messages
- action="write", to="agentA", message="..." - Send a message

At the start of your task, use announce to let other agents know what you're doing.
Check your inbox when notified about new messages.
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
