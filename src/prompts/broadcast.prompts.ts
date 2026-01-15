import type { ParallelAgent } from "../types";
import type { HandledMessage } from "../types";

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Use 'send_to' for a specific agent, or omit to message all. Use 'reply_to' to reply (auto-wires recipient to sender).`;

export function broadcastResult(
  alias: string,
  recipients: string[],
  parallelAgents: ParallelAgent[],
  handledMessage?: HandledMessage,
): string {
  const lines: string[] = [];

  // Identity first
  lines.push(`You are: ${alias}`);
  lines.push("");

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
    lines.push("");
    lines.push(`Replied to #${handledMessage.id} from ${handledMessage.from}:`);
    lines.push(`  "${handledMessage.body}"`);
  } else if (recipients.length > 0) {
    // Regular message (no reply_to)
    lines.push("");
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

export function resumeBroadcastPrompt(senderAlias: string): string {
  return `[Broadcast from ${senderAlias}]: New message received. Check your inbox.`;
}

export function parentNotifyMessage(alias: string, message: string): string {
  return `[Pocket Universe] Message from ${alias}: ${message}`;
}
