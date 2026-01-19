// =============================================================================
// Core messaging functions
// =============================================================================

import type { Message, ParallelAgent, HandledMessage } from '../types';
import { log, LOG } from '../logger';
import {
  sessionToAlias,
  aliasToSession,
  presentedMessages,
  getDescription,
  generateId,
  getNextMsgIndex,
  getInbox,
  MAX_INBOX_SIZE,
  getWorktree,
  sessionStates,
  getRootIdForSession,
} from '../state';
import { isWorktreeEnabled } from '../config';

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

export function markMessagesAsHandled(sessionId: string, msgIndices: number[]): HandledMessage[] {
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

export function markMessagesAsPresented(sessionId: string, msgIndices: number[]): void {
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
  const selfRootId = getRootIdForSession(sessionId);
  const agents: string[] = [];
  for (const [alias, sessId] of aliasToSession.entries()) {
    if (alias !== selfAlias) {
      // Filter by root session - only include agents from the same main session
      // Main sessions are completely isolated - agents NEVER cross main sessions
      const agentRootId = getRootIdForSession(sessId);
      if (selfRootId && agentRootId !== selfRootId) {
        continue; // Different main session, skip
      }
      agents.push(alias);
    }
  }
  return agents;
}

export function getParallelAgents(sessionId: string): ParallelAgent[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const selfRootId = getRootIdForSession(sessionId);
  const agents: ParallelAgent[] = [];
  for (const [alias, sessId] of aliasToSession.entries()) {
    // Exclude self
    if (alias === selfAlias) {
      continue;
    }

    // Filter by root session - only include agents from the same main session
    // Main sessions are completely isolated - agents NEVER cross main sessions
    const agentRootId = getRootIdForSession(sessId);
    if (selfRootId && agentRootId !== selfRootId) {
      continue; // Different main session, skip
    }

    // Check if agent is idle (completed)
    const state = sessionStates.get(sessId);
    const isIdle = state?.status === 'idle';

    agents.push({
      alias,
      description: getDescription(alias),
      // Only include worktree if feature is enabled
      worktree: isWorktreeEnabled() ? getWorktree(sessId) : undefined,
      idle: isIdle || undefined, // Only include if true
    });
  }
  return agents;
}
