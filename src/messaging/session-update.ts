// =============================================================================
// Session Update Notifications - sends ignored user messages to main session
// =============================================================================

import { log, LOG } from '../logger';
import {
  isStatusUpdateEnabled,
  isMessageSentEnabled,
  isSubagentCreationEnabled,
  isSubagentCompletionEnabled,
  isSessionResumptionEnabled,
} from '../config';
import { getStoredClient, getMainSessionId } from '../state';

// Update event types
export type SessionUpdateEvent =
  | 'status_update' // Broadcast without send_to (status update)
  | 'message_sent' // Broadcast with send_to (message to specific agent)
  | 'subagent_spawned' // Agent called subagent tool
  | 'subagent_completed' // Subagent finished its work
  | 'session_resumed'; // Session was resumed after being idle

export interface SessionUpdateDetails {
  // Common fields
  agentAlias: string;
  timestamp?: number;

  // For status_update
  status?: string;

  // For message_sent
  recipientAlias?: string;
  messagePreview?: string;

  // For subagent_spawned
  newAgentAlias?: string;
  taskDescription?: string;

  // For subagent_completed
  completedAgentAlias?: string;

  // For session_resumed
  resumedByAlias?: string;
  resumeReason?: string;
}

/**
 * Format the session update message for display
 */
function formatUpdateMessage(event: SessionUpdateEvent, details: SessionUpdateDetails): string {
  const timestamp = new Date(details.timestamp || Date.now()).toISOString().slice(11, 19);

  switch (event) {
    case 'status_update':
      return `[${timestamp}] [${details.agentAlias}] status: ${details.status || 'unknown'}`;

    case 'message_sent':
      const preview = details.messagePreview
        ? details.messagePreview.length > 60
          ? details.messagePreview.substring(0, 60) + '...'
          : details.messagePreview
        : '';
      return `[${timestamp}] [${details.agentAlias}] -> [${details.recipientAlias}]: ${preview}`;

    case 'subagent_spawned':
      return `[${timestamp}] [${details.agentAlias}] spawned ${details.newAgentAlias || 'unknown'}: ${details.taskDescription || 'no description'}`;

    case 'subagent_completed':
      return `[${timestamp}] [${details.completedAgentAlias || 'unknown'}] completed`;

    case 'session_resumed':
      return `[${timestamp}] [${details.agentAlias}] resumed${details.resumedByAlias ? ` by ${details.resumedByAlias}` : ''}${details.resumeReason ? ` (${details.resumeReason})` : ''}`;

    default:
      return `[${timestamp}] [${details.agentAlias}] ${event}`;
  }
}

/**
 * Send an ignored user message to the main session to notify about agent events.
 *
 * The message is marked with `ignored: true` so it:
 * - Is stored in the session history
 * - Is NOT sent to the LLM
 * - Is NOT displayed in the UI transcript
 * - Is visible for debugging/logging purposes
 *
 * @param event - The type of event that occurred
 * @param details - Details about the event
 */
export async function sendMainSessionUpdate(
  event: SessionUpdateEvent,
  details: SessionUpdateDetails,
): Promise<boolean> {
  // Get the main session ID (user's actual session, parent of all agents)
  const mainSessionId = getMainSessionId();
  if (!mainSessionId) {
    log.debug(LOG.SESSION, `Cannot send session update - no main session ID`, {
      event,
      agentAlias: details.agentAlias,
    });
    return false;
  }

  // Get the client
  const client = getStoredClient();
  if (!client) {
    log.warn(LOG.SESSION, `Cannot send session update - no client available`, {
      event,
      agentAlias: details.agentAlias,
    });
    return false;
  }

  // Format the update message
  const message = formatUpdateMessage(event, {
    ...details,
    timestamp: details.timestamp || Date.now(),
  });

  try {
    // Send an ignored user message to the main session
    await client.session.prompt({
      path: { id: mainSessionId },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            text: message,
            ignored: true,
          },
        ],
      } as unknown as {
        noReply: boolean;
        parts: Array<{ type: string; text: string; ignored?: boolean }>;
      },
    });

    log.debug(LOG.SESSION, `Session update sent to main session`, {
      event,
      mainSessionId,
      message,
    });

    return true;
  } catch (e) {
    log.warn(LOG.SESSION, `Failed to send session update to main session`, {
      event,
      mainSessionId,
      error: String(e),
    });
    return false;
  }
}

// Convenience functions for each event type

export function sendStatusUpdate(agentAlias: string, status: string): Promise<boolean> {
  if (!isStatusUpdateEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate('status_update', { agentAlias, status });
}

export function sendSubagentSpawned(
  spawnerAlias: string,
  newAgentAlias: string,
  taskDescription: string,
): Promise<boolean> {
  if (!isSubagentCreationEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate('subagent_spawned', {
    agentAlias: spawnerAlias,
    newAgentAlias,
    taskDescription,
  });
}

export function sendSubagentCompleted(completedAgentAlias: string): Promise<boolean> {
  if (!isSubagentCompletionEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate('subagent_completed', {
    agentAlias: completedAgentAlias,
    completedAgentAlias,
  });
}

export function sendSessionResumed(
  agentAlias: string,
  resumedByAlias?: string,
  reason?: string,
): Promise<boolean> {
  if (!isSessionResumptionEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate('session_resumed', {
    agentAlias,
    resumedByAlias,
    resumeReason: reason,
  });
}

export function sendMessageSent(
  senderAlias: string,
  recipientAlias: string,
  messagePreview: string,
): Promise<boolean> {
  if (!isMessageSentEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate('message_sent', {
    agentAlias: senderAlias,
    recipientAlias,
    messagePreview,
  });
}
