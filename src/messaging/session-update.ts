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
  isUserMessageSentEnabled,
} from '../config';
import { getStoredClient, getRootIdForSession } from '../state';

// Update event types
export type SessionUpdateEvent =
  | 'status_update' // Broadcast without send_to (status update)
  | 'message_sent' // Broadcast with send_to (message to specific agent)
  | 'subagent_spawned' // Agent called subagent tool
  | 'subagent_completed' // Subagent finished its work
  | 'session_resumed' // Session was resumed after being idle
  | 'user_message_sent'; // User sent message via /pocket command

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

  // For user_message_sent
  targetAlias?: string;
  userMessagePreview?: string;
}

/**
 * Format the session update message for display
 */
function formatUpdateMessage(event: SessionUpdateEvent, details: SessionUpdateDetails): string {
  const date = new Date(details.timestamp || Date.now());
  const timestamp = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

  switch (event) {
    case 'status_update':
      return `[${timestamp}] [${details.agentAlias}] status: ${details.status || 'unknown'}`;

    case 'message_sent':
      return `[${timestamp}] [${details.agentAlias}] -> [${details.recipientAlias}]: ${details.messagePreview || ''}`;

    case 'subagent_spawned':
      return `[${timestamp}] [${details.agentAlias}] spawned ${details.newAgentAlias || 'unknown'}: ${details.taskDescription || 'no description'}`;

    case 'subagent_completed':
      return `[${timestamp}] [${details.completedAgentAlias || 'unknown'}] idle`;

    case 'session_resumed':
      return `[${timestamp}] [${details.agentAlias}] resumed${details.resumedByAlias ? ` by ${details.resumedByAlias}` : ''}${details.resumeReason ? ` (${details.resumeReason})` : ''}`;

    case 'user_message_sent':
      return `[${timestamp}] [user] -> [${details.targetAlias || 'unknown'}]: ${details.userMessagePreview || ''}`;

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
 * IMPORTANT: Uses session-specific root lookup, NOT global state.
 * This ensures updates go to the correct main session when multiple exist.
 *
 * @param event - The type of event that occurred
 * @param details - Details about the event
 * @param sessionId - The session ID of the agent triggering the update (used to lookup root/main session)
 * @param mainSessionIdOverride - Optional override for the main session ID (used by /pocket command)
 */
export async function sendMainSessionUpdate(
  event: SessionUpdateEvent,
  details: SessionUpdateDetails,
  sessionId?: string,
  mainSessionIdOverride?: string,
): Promise<boolean> {
  // Determine the target main session ID
  // Priority: explicit override > lookup from sessionId > fail
  let mainSessionId: string | undefined;

  if (mainSessionIdOverride) {
    mainSessionId = mainSessionIdOverride;
  } else if (sessionId) {
    // Look up the root session (main session) for this agent
    mainSessionId = getRootIdForSession(sessionId);
  }

  if (!mainSessionId) {
    log.debug(LOG.SESSION, `Cannot send session update - no main session ID found`, {
      event,
      agentAlias: details.agentAlias,
      sessionId,
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
        hideQueueBadge: true,
        parts: [
          {
            type: 'text',
            text: message,
            ignored: true,
          },
        ],
      } as unknown as {
        noReply: boolean;
        hideQueueBadge: boolean;
        parts: Array<{ type: string; text: string; ignored?: boolean }>;
      },
    });

    log.debug(LOG.SESSION, `Session update sent to main session`, {
      event,
      mainSessionId,
      sessionId,
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
// All functions now require sessionId to ensure correct main session routing

export function sendStatusUpdate(
  sessionId: string,
  agentAlias: string,
  status: string,
): Promise<boolean> {
  if (!isStatusUpdateEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate('status_update', { agentAlias, status }, sessionId);
}

export function sendSubagentSpawned(
  sessionId: string,
  spawnerAlias: string,
  newAgentAlias: string,
  taskDescription: string,
): Promise<boolean> {
  if (!isSubagentCreationEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate(
    'subagent_spawned',
    {
      agentAlias: spawnerAlias,
      newAgentAlias,
      taskDescription,
    },
    sessionId,
  );
}

export function sendSubagentCompleted(
  sessionId: string,
  completedAgentAlias: string,
): Promise<boolean> {
  if (!isSubagentCompletionEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate(
    'subagent_completed',
    {
      agentAlias: completedAgentAlias,
      completedAgentAlias,
    },
    sessionId,
  );
}

export function sendSessionResumed(
  sessionId: string,
  agentAlias: string,
  resumedByAlias?: string,
  reason?: string,
): Promise<boolean> {
  if (!isSessionResumptionEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate(
    'session_resumed',
    {
      agentAlias,
      resumedByAlias,
      resumeReason: reason,
    },
    sessionId,
  );
}

export function sendMessageSent(
  sessionId: string,
  senderAlias: string,
  recipientAlias: string,
  messagePreview: string,
): Promise<boolean> {
  if (!isMessageSentEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate(
    'message_sent',
    {
      agentAlias: senderAlias,
      recipientAlias,
      messagePreview,
    },
    sessionId,
  );
}

/**
 * Send user message notification - uses mainSessionId directly since
 * the /pocket command already knows the main session.
 */
export function sendUserMessageSent(
  mainSessionId: string,
  targetAlias: string,
  messagePreview: string,
): Promise<boolean> {
  if (!isUserMessageSentEnabled()) return Promise.resolve(false);
  return sendMainSessionUpdate(
    'user_message_sent',
    {
      agentAlias: 'user',
      targetAlias,
      userMessagePreview: messagePreview,
    },
    undefined, // No sessionId lookup needed
    mainSessionId, // Use direct override
  );
}
