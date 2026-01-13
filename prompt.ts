// =============================================================================
// All LLM-facing prompts for the iam plugin
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. First call registers you and shows other agents. Use 'recipient' for specific agent(s), or omit to message all.`;

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

export function broadcastResult(
  alias: string,
  recipients: string[],
  messageId: string,
  parallelAgents: ParallelAgent[],
  isFirstCall: boolean
): string {
  const lines: string[] = [];
  
  // Always show identity
  lines.push(`YOUR ALIAS: ${alias}`);
  lines.push(`(Do NOT use "${alias}" as the "recipient" target - that's YOU!)`);
  lines.push(``);
  
  // Show message confirmation
  if (recipients.length > 0) {
    const recipientStr = recipients.length === 1 ? recipients[0] : recipients.join(", ");
    lines.push(`Message sent to: ${recipientStr}`);
    lines.push(`Message ID: ${messageId}`);
  }
  
  // Show other agents (on first call or when useful)
  if (isFirstCall || parallelAgents.length > 0) {
    lines.push(``);
    if (parallelAgents.length > 0) {
      lines.push(`--- Other Agents ---`);
      for (const agent of parallelAgents) {
        if (agent.description) {
          lines.push(`- ${agent.alias}: ${agent.description}`);
        } else {
          lines.push(`- ${agent.alias}: (no status yet)`);
        }
      }
    } else {
      lines.push(`No other agents running yet.`);
    }
  }
  
  return lines.join("\n");
}

export const BROADCAST_MISSING_MESSAGE = `Error: 'message' parameter is required.`;

export function broadcastUnknownRecipient(recipient: string, known: string[]): string {
  const list = known.length > 0 ? `Known agents: ${known.join(", ")}` : "No agents available yet.";
  return `Error: Unknown recipient "${recipient}". ${list}`;
}

// =============================================================================
// System prompt injection
// =============================================================================

export const SYSTEM_PROMPT = `
<instructions tool="iam">
# Inter-Agent Messaging

You have access to the \`broadcast\` tool for communicating with other parallel agents.

Usage:
- broadcast(message="...") - Send to all agents (also registers you and shows other agents)
- broadcast(recipient="agentA", message="...") - Send to specific agent
- broadcast(recipient="agentA,agentC", message="...") - Send to multiple agents

Your first broadcast registers you and shows who else is running. Subsequent calls show delivery confirmation.

IMPORTANT: When other agents message you, their messages appear in your context as tool results from "iam_message". 
READ THESE CAREFULLY and respond to any questions they ask!

When you complete your task, broadcast to all: "Done. Here's what I found/did: ..."
</instructions>
`;

