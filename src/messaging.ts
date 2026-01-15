// =============================================================================
// Core messaging functions
// =============================================================================

import type { Message } from "./types";
import type { ParallelAgent, HandledMessage } from "./prompt";
import { log, LOG } from "./logger";
import {
  sessionToAlias,
  aliasToSession,
  presentedMessages,
  sessionStates,
  getStoredClient,
  getDescription,
  generateId,
  getNextMsgIndex,
  getInbox,
  MAX_INBOX_SIZE,
  getWorktree,
} from "./state";
import { isWorktreeEnabled } from "./config";

// Re-export injection functions for backwards compatibility
export {
  getParentId,
  isChildSession,
  createInboxMessage,
  createSpawnTaskMessage,
  createWorktreeSummaryMessage,
  injectTaskPartToParent,
  fetchSpawnOutput,
  markSpawnCompleted,
} from "./injection";

// ============================================================================
// Core messaging functions
// ============================================================================

export function sendMessage(from: string, to: string, body: string): Message {
  const message: Message = {
    id: generateId(),
    msgIndex: getNextMsgIndex(to),
    from,
    to,
    body,
    timestamp: Date.now(),
    handled: false,
  };

  const queue = getInbox(to);

  // Enforce max queue size
  if (queue.length >= MAX_INBOX_SIZE) {
    // Remove oldest handled message, or oldest message if all unhandled
    const handledIndex = queue.findIndex((m) => m.handled);
    if (handledIndex !== -1) {
      queue.splice(handledIndex, 1);
    } else {
      queue.shift();
    }
    log.warn(LOG.MESSAGE, `Queue full, removed oldest message`, { to });
  }

  queue.push(message);
  log.info(LOG.MESSAGE, `Message sent`, {
    id: message.id,
    msgIndex: message.msgIndex,
    from,
    to,
    bodyLength: body.length,
  });
  return message;
}

/**
 * Resume an idle session by sending a broadcast message as a user prompt.
 * This "wakes up" the idle agent to process the message.
 */
export async function resumeSessionWithBroadcast(
  recipientSessionId: string,
  senderAlias: string,
  messageContent: string,
): Promise<boolean> {
  const storedClient = getStoredClient();
  if (!storedClient) {
    log.warn(LOG.MESSAGE, `Cannot resume session - no client available`);
    return false;
  }

  const recipientAlias = sessionToAlias.get(recipientSessionId) || "unknown";

  log.info(LOG.MESSAGE, `Resuming idle session with broadcast`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
    messageLength: messageContent.length,
  });

  try {
    // Format the resume prompt - DON'T include full message content
    // because the synthetic injection will show it. Just notify that new messages arrived.
    const resumePrompt = `[Broadcast from ${senderAlias}]: New message received. Check your inbox.`;

    // Mark session as active before resuming
    const state = sessionStates.get(recipientSessionId);
    if (state) {
      state.status = "active";
      state.lastActivity = Date.now();
    }

    log.info(LOG.MESSAGE, `Session resumed successfully`, {
      recipientSessionId,
      recipientAlias,
    });

    // Fire off the resume in the background but track its completion
    // We use prompt() (not promptAsync) and await it so we know when it finishes
    // This is wrapped in an IIFE so we don't block the caller
    (async () => {
      try {
        await storedClient!.session.prompt({
          path: { id: recipientSessionId },
          body: {
            parts: [{ type: "text", text: resumePrompt }],
          },
        });

        // Mark session as idle after prompt completes
        const stateAfter = sessionStates.get(recipientSessionId);
        if (stateAfter) {
          stateAfter.status = "idle";
          stateAfter.lastActivity = Date.now();
        }

        log.info(LOG.MESSAGE, `Resumed session completed, marked idle`, {
          recipientSessionId,
          recipientAlias,
        });

        // Check for messages that need resumption (unhandled AND not presented)
        const unreadMessages = getMessagesNeedingResume(recipientSessionId);
        if (unreadMessages.length > 0) {
          log.info(
            LOG.MESSAGE,
            `Resumed session has new unread messages, resuming again`,
            {
              recipientSessionId,
              recipientAlias,
              unreadCount: unreadMessages.length,
            },
          );

          // Resume with the first unread message
          const firstUnread = unreadMessages[0];
          const senderAlias = firstUnread.from;

          // Mark this message as presented BEFORE resuming to avoid infinite loop
          markMessagesAsPresented(recipientSessionId, [firstUnread.msgIndex]);

          await resumeSessionWithBroadcast(
            recipientSessionId,
            senderAlias,
            firstUnread.body,
          );
        }
      } catch (e) {
        log.error(LOG.MESSAGE, `Resumed session failed`, {
          recipientSessionId,
          error: String(e),
        });
        // Mark as idle on error too
        const stateErr = sessionStates.get(recipientSessionId);
        if (stateErr) {
          stateErr.status = "idle";
        }
      }
    })();

    return true;
  } catch (e) {
    log.error(LOG.MESSAGE, `Failed to resume session`, {
      recipientSessionId,
      error: String(e),
    });
    return false;
  }
}

export function getUnhandledMessages(sessionId: string): Message[] {
  return getInbox(sessionId).filter((m) => !m.handled);
}

/**
 * Get messages that need resumption: unhandled AND not presented via transform.
 * - Unhandled: agent didn't use reply_to to respond
 * - Not presented: agent didn't see the message in their context (via transform injection)
 * Only these messages should trigger a resume - they're truly "unseen" by the agent.
 */
export function getMessagesNeedingResume(sessionId: string): Message[] {
  const unhandled = getUnhandledMessages(sessionId);
  const presented = presentedMessages.get(sessionId);
  if (!presented || presented.size === 0) {
    return unhandled; // No messages were presented, all unhandled need resume
  }
  // Filter out messages that were already presented to the agent
  return unhandled.filter((m) => !presented.has(m.msgIndex));
}

export function markMessagesAsHandled(
  sessionId: string,
  msgIndices: number[],
): HandledMessage[] {
  const queue = getInbox(sessionId);
  const handled: HandledMessage[] = [];
  for (const msg of queue) {
    if (msgIndices.includes(msg.msgIndex) && !msg.handled) {
      msg.handled = true;
      handled.push({
        id: msg.msgIndex,
        from: msg.from,
        body: msg.body,
      });
      log.info(LOG.MESSAGE, `Message marked as handled`, {
        sessionId,
        msgIndex: msg.msgIndex,
        from: msg.from,
      });
    }
  }
  return handled;
}

export function markMessagesAsPresented(
  sessionId: string,
  msgIndices: number[],
): void {
  let presented = presentedMessages.get(sessionId);
  if (!presented) {
    presented = new Set();
    presentedMessages.set(sessionId, presented);
  }
  for (const idx of msgIndices) {
    presented.add(idx);
  }
  log.debug(LOG.MESSAGE, `Marked messages as presented (seen by agent)`, {
    sessionId,
    indices: msgIndices,
  });
}

export function getKnownAliases(sessionId: string): string[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const agents: string[] = [];
  for (const alias of aliasToSession.keys()) {
    if (alias !== selfAlias) {
      agents.push(alias);
    }
  }
  return agents;
}

export function getParallelAgents(sessionId: string): ParallelAgent[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const agents: ParallelAgent[] = [];
  for (const [alias, sessId] of aliasToSession.entries()) {
    // All registered sessions are child sessions (we check parentID before registering)
    // Just exclude self
    if (alias !== selfAlias) {
      agents.push({
        alias,
        description: getDescription(alias),
        // Only include worktree if feature is enabled
        worktree: isWorktreeEnabled() ? getWorktree(sessId) : undefined,
      });
    }
  }
  return agents;
}
