// =============================================================================
// Resume and output piping functions
// =============================================================================

import { resumeBroadcastPrompt } from '../prompts/broadcast.prompts';
import { formatSubagentOutput } from '../prompts/subagent.prompts';
import { log, LOG } from '../logger';
import {
  sessionToAlias,
  sessionStates,
  getStoredClient,
  pendingSubagentOutputs,
  getOrFetchModelInfo,
  sessionsInBeforeIdleHook,
  noReplyDeliveredSessions,
} from '../state';
import { getMessagesNeedingResume, markMessagesAsPresented } from './core';
import { sendSessionResumed } from './session-update';

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

  const recipientAlias = sessionToAlias.get(recipientSessionId) || 'unknown';

  log.info(LOG.MESSAGE, `Resuming idle session with broadcast`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
    messageLength: messageContent.length,
  });

  try {
    // Format the resume prompt - DON'T include full message content
    // because the synthetic injection will show it. Just notify that new messages arrived.
    const resumePrompt = resumeBroadcastPrompt(senderAlias);

    // Mark session as active before resuming
    const state = sessionStates.get(recipientSessionId);
    if (state) {
      state.status = 'active';
      state.lastActivity = Date.now();
    }

    log.info(LOG.MESSAGE, `Session resumed successfully`, {
      recipientSessionId,
      recipientAlias,
    });

    // Send session update to main session (if enabled)
    sendSessionResumed(recipientAlias, senderAlias, 'broadcast').catch(() => {
      // Ignore errors - this is a fire-and-forget notification
    });

    // Fire off the resume in the background but track its completion
    // We use prompt() (not promptAsync) and await it so we know when it finishes
    // This is wrapped in an IIFE so we don't block the caller
    (async () => {
      try {
        // Get the TARGET session's agent/model info (with fallback to fetch)
        const modelInfo = await getOrFetchModelInfo(storedClient, recipientSessionId);

        log.debug(LOG.MESSAGE, `Resume using model info`, {
          recipientSessionId,
          recipientAlias,
          agent: modelInfo?.agent,
          modelID: modelInfo?.model?.modelID,
          providerID: modelInfo?.model?.providerID,
        });

        await storedClient.session.prompt({
          path: { id: recipientSessionId },
          body: {
            parts: [{ type: 'text', text: resumePrompt }],
            agent: modelInfo?.agent,
            model: modelInfo?.model,
          },
        });

        // Mark session as idle after prompt completes
        const stateAfter = sessionStates.get(recipientSessionId);
        if (stateAfter) {
          stateAfter.status = 'idle';
          stateAfter.lastActivity = Date.now();
        }

        log.info(LOG.MESSAGE, `Resumed session completed, marked idle`, {
          recipientSessionId,
          recipientAlias,
        });

        // Check for messages that need resumption (unhandled AND not presented)
        const unreadMessages = getMessagesNeedingResume(recipientSessionId);
        if (unreadMessages.length > 0) {
          log.info(LOG.MESSAGE, `Resumed session has new unread messages, resuming again`, {
            recipientSessionId,
            recipientAlias,
            unreadCount: unreadMessages.length,
          });

          // Resume with the first unread message
          const firstUnread = unreadMessages[0];
          const senderAlias = firstUnread.from;

          // Mark this message as presented BEFORE resuming to avoid infinite loop
          markMessagesAsPresented(recipientSessionId, [firstUnread.msgIndex]);

          await resumeSessionWithBroadcast(recipientSessionId, senderAlias, firstUnread.body);
        }
      } catch (e) {
        log.error(LOG.MESSAGE, `Resumed session failed`, {
          recipientSessionId,
          error: String(e),
        });
        // Mark as idle on error too
        const stateErr = sessionStates.get(recipientSessionId);
        if (stateErr) {
          stateErr.status = 'idle';
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

/**
 * Pipe subagent output to the caller session (forced_attention: false mode).
 *
 * When caller is ACTIVE: Use session.prompt({ noReply: true }) to inject visible message mid-stream
 * When caller is IDLE: Store in pendingSubagentOutputs, hook uses resumePrompt to resume
 */
export async function resumeWithSubagentOutput(
  recipientSessionId: string,
  senderAlias: string,
  subagentOutput: string,
): Promise<boolean> {
  const recipientAlias = sessionToAlias.get(recipientSessionId) || 'unknown';

  // Format the output message
  const formattedOutput = formatSubagentOutput(senderAlias, subagentOutput);

  // Check caller state to decide delivery mechanism
  const callerState = sessionStates.get(recipientSessionId);
  const callerIsIdle = callerState?.status === 'idle';

  // Check if caller is currently in session.before.idle hook (waiting for subagents)
  // This is set by the hook when it starts and cleared when it ends
  const callerInHook = sessionsInBeforeIdleHook.has(recipientSessionId);

  log.info(LOG.MESSAGE, `Piping subagent output to caller (no forced attention)`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
    callerIsIdle,
    callerInHook,
    outputLength: subagentOutput.length,
  });

  // Send session update to main session (if enabled) - subagent completed triggers resume
  if (!callerIsIdle && !callerInHook) {
    sendSessionResumed(recipientAlias, senderAlias, 'subagent_output').catch(() => {
      // Ignore errors - this is a fire-and-forget notification
    });
  }

  // ALWAYS store in pendingSubagentOutputs first (safety net for race conditions)
  // The hook will check this after waiting for subagents
  pendingSubagentOutputs.set(recipientSessionId, {
    senderAlias,
    output: formattedOutput,
  });

  const storedClient = getStoredClient();

  // TRULY ACTIVE CALLER: Also use noReply to inject message mid-stream
  // Only use this path if caller is NOT idle AND NOT in session.before.idle hook
  // The noReply allows the model to see the message on its next LLM call (if any)
  if (!callerIsIdle && !callerInHook && storedClient) {
    try {
      const modelInfo = await getOrFetchModelInfo(storedClient, recipientSessionId);

      log.debug(LOG.MESSAGE, `Persisting visible subagent output for truly active caller`, {
        recipientSessionId,
        recipientAlias,
        senderAlias,
        agent: modelInfo?.agent,
        modelID: modelInfo?.model?.modelID,
      });

      await storedClient.session.prompt({
        path: { id: recipientSessionId },
        body: {
          noReply: true,
          parts: [{ type: 'text', text: formattedOutput }],
          agent: modelInfo?.agent,
          model: modelInfo?.model,
        } as unknown as {
          parts: Array<{ type: string; text: string }>;
          noReply: boolean;
          agent?: string;
          model?: { modelID?: string; providerID?: string };
        },
      });

      log.info(LOG.MESSAGE, `Persisted visible subagent output for truly active caller`, {
        recipientSessionId,
        recipientAlias,
        senderAlias,
      });

      // Mark that noReply was used - hook should NOT also set resumePrompt
      // (to avoid duplicate delivery)
      noReplyDeliveredSessions.add(recipientSessionId);

      // Also remove from pendingSubagentOutputs since noReply handled it
      pendingSubagentOutputs.delete(recipientSessionId);

      return true;
    } catch (e) {
      log.warn(LOG.MESSAGE, `Failed to persist visible message, pending will be used`, {
        recipientSessionId,
        recipientAlias,
        senderAlias,
        error: String(e),
      });
      // pendingSubagentOutputs already set, hook will handle it
    }
  }

  // IDLE CALLER or CALLER IN HOOK: pendingSubagentOutputs is already set above
  // The hook will pick it up:
  // - If caller is idle: hook will fire on next activity
  // - If caller is in hook: after waitForSessionIdle returns, hook checks pendingSubagentOutputs
  log.info(LOG.MESSAGE, `Subagent output stored for hook pickup`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
    reason: callerInHook ? 'caller_in_hook' : callerIsIdle ? 'caller_idle' : 'fallback',
  });

  return true;
}
