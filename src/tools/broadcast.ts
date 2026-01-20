// =============================================================================
// Broadcast tool definition
// =============================================================================

import { tool } from '@opencode-ai/plugin';
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  BROADCAST_SELF_MESSAGE,
  broadcastUnknownRecipient,
  broadcastResult,
  parentNotifyMessage,
} from '../prompts/broadcast.prompts';
import { log, LOG } from '../logger';
import type { OpenCodeSessionClient, ToolContext, InternalClient, HandledMessage } from '../types';
import {
  sessionStates,
  announcedSessions,
  getAlias,
  setDescription,
  resolveAlias,
  registerSession,
  MAX_MESSAGE_LENGTH,
} from '../state';
import {
  sendMessage,
  resumeSessionWithBroadcast,
  markMessagesAsHandled,
  getKnownAliases,
  getParallelAgents,
  sendStatusUpdate,
  sendMessageSent,
} from '../messaging';
import { getParentId } from '../injection/index';
export function createBroadcastTool(client: OpenCodeSessionClient) {
  return tool({
    description: BROADCAST_DESCRIPTION,
    args: {
      send_to: tool.schema
        .string()
        .optional()
        .describe('Target agent (single agent only). Omit to send to all.'),
      message: tool.schema.string().describe('Your message'),
      reply_to: tool.schema.number().optional().describe('Message ID to mark as handled'),
    },
    async execute(args, context: ToolContext) {
      const sessionId = context.sessionID;

      // Check if this is the first broadcast call (agent announcing themselves)
      const isFirstCall = !announcedSessions.has(sessionId);

      // Session should already be registered via system.transform hook
      // If not registered, that's a bug - don't register without rootId or agent becomes invisible
      if (!getAlias(sessionId)) {
        log.warn(LOG.TOOL, `Session not registered - broadcast cannot continue`, {
          sessionId,
          hint: 'Session should be registered via system.transform hook before first broadcast',
        });
        return 'Internal error: Session not properly initialized. Please try again.';
      }

      const alias = getAlias(sessionId);

      if (!args.message) {
        log.warn(LOG.TOOL, `broadcast missing 'message'`, { alias });
        return BROADCAST_MISSING_MESSAGE;
      }

      // Truncate message if too long (don't error - just truncate)
      let messageContent = args.message;
      if (messageContent.length > MAX_MESSAGE_LENGTH) {
        log.warn(LOG.TOOL, `broadcast message truncated`, {
          alias,
          originalLength: messageContent.length,
          truncatedTo: MAX_MESSAGE_LENGTH,
        });
        messageContent = messageContent.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]';
      }

      // Get parallel agents info early (needed for first call)
      const parallelAgents = getParallelAgents(sessionId);

      log.info(LOG.TOOL, `broadcast called`, {
        alias,
        send_to: args.send_to,
        reply_to: args.reply_to,
        messageLength: messageContent.length,
        isFirstCall,
      });

      // Handle reply_to - mark message as handled and auto-wire recipient
      let handledMessage: HandledMessage | undefined;
      let autoRecipient: string | undefined;
      if (args.reply_to !== undefined) {
        // Mark as announced if first call (even if replying)
        if (isFirstCall) {
          announcedSessions.add(sessionId);
        }

        const handled = markMessagesAsHandled(sessionId, [args.reply_to]);
        if (handled.length > 0) {
          handledMessage = handled[0];
          autoRecipient = handledMessage.from; // Auto-wire to sender

          // Warn if send_to was provided but will be ignored
          if (args.send_to && args.send_to !== autoRecipient) {
            log.warn(LOG.TOOL, `reply_to provided - ignoring send_to param`, {
              alias,
              providedSendTo: args.send_to,
              autoWiredRecipient: autoRecipient,
            });
          }

          log.info(LOG.TOOL, `Handled message via reply_to`, {
            alias,
            msgId: args.reply_to,
            autoRecipient,
          });
        }
      }

      const knownAgents = getKnownAliases(sessionId);
      let targetAliases: string[];

      if (autoRecipient) {
        // reply_to takes precedence - ALWAYS auto-wire to the sender, ignore send_to param
        targetAliases = [autoRecipient];
      } else if (!args.send_to) {
        // No target specified - broadcast to all = STATUS UPDATE ONLY
        // Mark as announced and update status
        announcedSessions.add(sessionId);
        setDescription(sessionId, messageContent);

        log.info(LOG.TOOL, `Broadcast to all - status update only`, {
          alias,
          status: messageContent.substring(0, 80),
          knownAgents,
        });

        // Send session update to main session (if enabled)
        sendStatusUpdate(sessionId, alias, messageContent).catch(() => {
          // Ignore errors - this is a fire-and-forget notification
        });

        // Return early - no messages added to queue, no agents resumed
        return broadcastResult(alias, knownAgents, parallelAgents, undefined);
      } else {
        // Explicit recipient specified - single target only
        targetAliases = [args.send_to.trim()];
      }

      // If no agents to send to, just return info
      if (targetAliases.length === 0) {
        log.info(LOG.TOOL, `No recipients, returning agent info`, {
          alias,
        });
        return broadcastResult(alias, [], parallelAgents, handledMessage);
      }

      // DORMANT: parent alias feature
      const parentId = await getParentId(client, sessionId);

      const recipientSessions: string[] = [];
      const validTargets: string[] = [];
      for (const targetAlias of targetAliases) {
        const recipientSessionId = resolveAlias(targetAlias, parentId);
        if (!recipientSessionId) {
          log.warn(LOG.TOOL, `broadcast unknown recipient`, {
            alias,
            to: targetAlias,
          });
          return broadcastUnknownRecipient(targetAlias, knownAgents);
        }
        if (recipientSessionId === sessionId) {
          log.warn(LOG.TOOL, `Skipping self-message`, {
            alias,
            targetAlias,
          });
          if (targetAliases.length === 1) {
            return BROADCAST_SELF_MESSAGE;
          }
          continue;
        }
        recipientSessions.push(recipientSessionId);
        validTargets.push(targetAlias);
      }

      if (recipientSessions.length === 0) {
        log.info(LOG.TOOL, `No valid recipients after filtering`, {
          alias,
        });
        return broadcastResult(alias, [], parallelAgents, handledMessage);
      }

      // DORMANT: parent alias feature
      // Check if we're broadcasting to parent
      const isTargetingParent = parentId && recipientSessions.includes(parentId);

      // Send messages to all recipients
      // Check if recipient is idle and resume if so
      const resumedSessions: string[] = [];

      log.debug(LOG.TOOL, `Broadcast checking session states`, {
        alias,
        recipientCount: recipientSessions.length,
        sessionStatesSize: sessionStates.size,
        trackedSessions: Array.from(sessionStates.keys()),
      });

      for (let i = 0; i < recipientSessions.length; i++) {
        const recipientSessionId = recipientSessions[i];
        const recipientAlias = validTargets[i];
        const recipientState = sessionStates.get(recipientSessionId);

        log.debug(LOG.TOOL, `Checking recipient state`, {
          recipientSessionId,
          recipientAlias,
          hasState: !!recipientState,
          status: recipientState?.status,
        });

        // Always store the message in inbox first
        sendMessage(alias, recipientSessionId, messageContent);

        // Send session update to main session (if enabled)
        sendMessageSent(sessionId, alias, recipientAlias, messageContent).catch(() => {
          // Ignore errors - this is a fire-and-forget notification
        });

        // If recipient is idle, also resume the session
        if (recipientState?.status === 'idle') {
          const resumed = await resumeSessionWithBroadcast(
            recipientSessionId,
            alias,
            messageContent,
          );
          if (resumed) {
            resumedSessions.push(recipientAlias);
          }
        }
      }

      if (resumedSessions.length > 0) {
        log.info(LOG.TOOL, `Resumed idle sessions via broadcast`, {
          alias,
          resumedSessions,
        });
      }

      // Notify parent session if targeted (DORMANT)
      if (isTargetingParent) {
        log.info(LOG.MESSAGE, `Broadcasting to parent session, calling notify_once`, {
          sessionId,
          parentId,
        });
        try {
          const internalClient = (client as unknown as { _client?: InternalClient })._client;
          if (internalClient?.post) {
            await internalClient.post({
              url: `/session/${parentId}/notify_once`,
              body: {
                text: parentNotifyMessage(alias, args.message),
              },
            });
            log.info(LOG.MESSAGE, `Parent session notified successfully`, {
              parentId,
            });
          }
        } catch (e) {
          log.warn(LOG.MESSAGE, `Failed to notify parent session`, {
            parentId,
            error: String(e),
          });
        }
      }

      return broadcastResult(alias, validTargets, parallelAgents, handledMessage);
    },
  });
}
