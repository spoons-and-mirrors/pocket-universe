// =============================================================================
// Broadcast tool prompts
// =============================================================================

import type { ParallelAgent, HandledMessage } from '../types';
import { render } from './render';

// =============================================================================
// TEMPLATES - readable prompts with {{placeholders}}
// =============================================================================

export const BROADCAST_DESCRIPTION = `Communicate with other parallel agents. Use 'send_to' for a specific agent, or omit to message all. Use 'reply_to' to reply (auto-wires recipient to sender).`;

/**
 * Result shown after a broadcast call.
 * {{agentsSection}} - list of available agents with status
 * {{confirmationSection}} - reply confirmation or message sent
 */
const BROADCAST_RESULT_TEMPLATE = `You are: {{selfAlias}}

{{agentsSection}}
{{confirmationSection}}`;

const BROADCAST_RESUME_TEMPLATE = `[Broadcast from {{sender}}]: New message received. Check your inbox.`;

const PARENT_NOTIFY_TEMPLATE = `[Pocket Universe] Message from {{alias}}: {{message}}`;

const UNKNOWN_RECIPIENT_TEMPLATE = `Error: Unknown recipient "{{recipient}}". {{knownList}}`;

// =============================================================================
// ERROR MESSAGES
// =============================================================================

export const BROADCAST_MISSING_MESSAGE = `Error: 'message' parameter is required.`;

export const BROADCAST_SELF_MESSAGE = `Warning: You cannot send a message to yourself. The target alias is your own alias. Choose a different recipient.`;

// =============================================================================
// SECTION BUILDERS - logic for {{placeholders}}
// =============================================================================

function buildAgentsSection(agents: ParallelAgent[]): string {
  if (agents.length === 0) {
    return `No other agents available yet.`;
  }

  const lines: string[] = [`Available agents:`];

  for (const agent of agents) {
    // Agent name with optional worktree
    let agentLine = `  - ${agent.alias}`;
    if (agent.worktree) {
      agentLine += ` [worktree: ${agent.worktree}]`;
    }
    lines.push(agentLine);

    // Status history (most recent last)
    if (agent.description && agent.description.length > 0) {
      for (const status of agent.description) {
        lines.push(`      → ${status}`);
      }
    }
  }

  return lines.join('\n');
}

function buildConfirmationSection(recipients: string[], handledMessage?: HandledMessage): string {
  // Reply confirmation takes precedence
  if (handledMessage) {
    return `Replied to #${handledMessage.id} from ${handledMessage.from}:
  "${handledMessage.body}"`;
  }

  // Regular message sent
  if (recipients.length > 0) {
    const recipientStr = recipients.length === 1 ? recipients[0] : recipients.join(', ');
    return `Message sent to: ${recipientStr}`;
  }

  return '';
}

// =============================================================================
// RENDER FUNCTIONS - combine templates with section builders
// =============================================================================

export function broadcastResult(
  alias: string,
  recipients: string[],
  parallelAgents: ParallelAgent[],
  handledMessage?: HandledMessage,
): string {
  return render(BROADCAST_RESULT_TEMPLATE, {
    selfAlias: alias,
    agentsSection: buildAgentsSection(parallelAgents),
    confirmationSection: buildConfirmationSection(recipients, handledMessage),
  });
}

export function resumeBroadcastPrompt(senderAlias: string): string {
  return render(BROADCAST_RESUME_TEMPLATE, { sender: senderAlias });
}

export function parentNotifyMessage(alias: string, message: string): string {
  return render(PARENT_NOTIFY_TEMPLATE, { alias, message });
}

export function broadcastUnknownRecipient(recipient: string, known: string[]): string {
  const knownList =
    known.length > 0 ? `Known agents: ${known.join(', ')}` : 'No agents available yet.';
  return render(UNKNOWN_RECIPIENT_TEMPLATE, { recipient, knownList });
}
