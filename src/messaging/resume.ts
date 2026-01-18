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
} from '../state';
import { getMessagesNeedingResume, markMessagesAsPresented } from './core';

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
 * Store subagent output for the caller to pick up via session.before_complete.
 * This is used when subagent_result_forced_attention is false.
 *
 * When caller is ACTIVE: stores in pendingSubagentOutputs, session.before_complete fires prompt
 * When caller is IDLE: stores in pendingSubagentOutputs AND resumes the session
 */
export async function resumeWithSubagentOutput(
  recipientSessionId: string,
  senderAlias: string,
  subagentOutput: string,
): Promise<boolean> {
  const recipientAlias = sessionToAlias.get(recipientSessionId) || 'unknown';

  // Format the output message
  const formattedOutput = formatSubagentOutput(senderAlias, subagentOutput);

  // Check if caller is idle
  const callerState = sessionStates.get(recipientSessionId);
  const callerIsIdle = callerState?.status === 'idle';

  log.info(LOG.MESSAGE, `Piping subagent output to caller (no forced attention)`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
    callerIsIdle,
    outputLength: subagentOutput.length,
  });

  // ALWAYS store in pendingSubagentOutputs for session.before_complete to pick up
  // This ensures the caller processes the output when it finishes current work
  pendingSubagentOutputs.set(recipientSessionId, {
    senderAlias,
    output: formattedOutput,
  });

  log.info(LOG.MESSAGE, `Subagent output stored for caller`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
  });

  // If caller is idle, we need to resume the session so session.before_complete fires
  if (callerIsIdle) {
    log.info(LOG.MESSAGE, `Caller is idle, resuming to process subagent output`, {
      recipientSessionId,
      recipientAlias,
      senderAlias,
    });

    const storedClient = getStoredClient();
    if (storedClient) {
      try {
        // Get the TARGET session's agent/model info (with fallback to fetch)
        const modelInfo = await getOrFetchModelInfo(storedClient, recipientSessionId);

        log.debug(LOG.MESSAGE, `Subagent output resume using model info`, {
          recipientSessionId,
          recipientAlias,
          agent: modelInfo?.agent,
          modelID: modelInfo?.model?.modelID,
          providerID: modelInfo?.model?.providerID,
        });

        // Mark session as active before resuming
        if (callerState) {
          callerState.status = 'active';
          callerState.lastActivity = Date.now();
        }

        // Fire the resume - session.before_complete will pick up pendingSubagentOutputs
        // We use the formatted output directly so the agent sees it
        await storedClient.session.prompt({
          path: { id: recipientSessionId },
          body: {
            parts: [{ type: 'text', text: formattedOutput }],
            agent: modelInfo?.agent,
            model: modelInfo?.model,
          },
        });

        log.info(LOG.MESSAGE, `Resumed idle caller to process subagent output`, {
          recipientSessionId,
          recipientAlias,
          senderAlias,
        });

        return true;
      } catch (e) {
        log.error(LOG.MESSAGE, `Failed to resume idle caller for subagent output`, {
          recipientSessionId,
          recipientAlias,
          senderAlias,
          error: String(e),
        });
        return false;
      }
    } else {
      log.warn(LOG.MESSAGE, `Cannot resume idle caller - no client available`, {
        recipientSessionId,
        recipientAlias,
      });
      return false;
    }
  }

  // Caller is active - session.before_complete will pick up pendingSubagentOutputs
  return true;
}
