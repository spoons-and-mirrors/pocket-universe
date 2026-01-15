// =============================================================================
// Tool definitions: broadcast and subagent
// =============================================================================

import { tool } from "@opencode-ai/plugin";
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  BROADCAST_SELF_MESSAGE,
  broadcastUnknownRecipient,
  broadcastResult,
  SUBAGENT_DESCRIPTION,
  SUBAGENT_NOT_CHILD_SESSION,
  SUBAGENT_MISSING_PROMPT,
  subagentResult,
  type HandledMessage,
  parentNotifyMessage,
  SUBAGENT_CREATE_FAILED,
  receivedSubagentOutput,
  subagentError,
  RECALL_DESCRIPTION,
  recallNotFound,
  RECALL_EMPTY,
} from "./prompt";
import { log, LOG } from "./logger";
import type { OpenCodeSessionClient, ToolContext, SubagentInfo } from "./types";
import {
  sessionToAlias,
  aliasToSession,
  sessionStates,
  announcedSessions,
  activeSubagents,
  callerPendingSubagents,
  getAlias,
  setDescription,
  resolveAlias,
  registerSession,
  MAX_MESSAGE_LENGTH,
  setWorktree,
  getWorktree,
  removeWorktree,
  saveAgentToHistory,
  recallAgents,
} from "./state";
import {
  sendMessage,
  resumeSessionWithBroadcast,
  resumeWithSubagentOutput,
  getMessagesNeedingResume,
  markMessagesAsHandled,
  markMessagesAsPresented,
  getKnownAliases,
  getParallelAgents,
  getParentId,
  injectTaskPartToParent,
  fetchSubagentOutput,
  markSubagentCompleted,
} from "./messaging";
import type { InternalClient } from "./types";
import { createAgentWorktree, removeAgentWorktree } from "./worktree";
import { isWorktreeEnabled, isSubagentResultForcedAttention } from "./config";

// ============================================================================
// Helper: Get caller's agent and model info from their session messages
// ============================================================================

interface CallerModelInfo {
  agent?: string;
  model?: { modelID?: string; providerID?: string };
}

/**
 * Get the caller's agent and model info from their latest assistant message.
 * This is used to inherit agent/model when creating new subagent sessions.
 */
async function getCallerModelInfo(
  client: OpenCodeSessionClient,
  sessionId: string,
): Promise<CallerModelInfo> {
  try {
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
    });

    const messages = messagesResult.data;
    if (!messages || messages.length === 0) {
      log.debug(LOG.TOOL, `No messages found for session`, { sessionId });
      return {};
    }

    // Find the latest assistant message (has agent/model info)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info.role === "assistant") {
        const info: CallerModelInfo = {};

        // Type assertion to access agent/model fields not in minimal interface
        const msgInfo = msg.info as {
          id: string;
          role: string;
          sessionID: string;
          agent?: string;
          model?: { modelID?: string; providerID?: string };
          modelID?: string;
          providerID?: string;
        };

        if (msgInfo.agent) {
          info.agent = msgInfo.agent;
        }

        if (msgInfo.model) {
          info.model = msgInfo.model;
        } else if (msgInfo.modelID || msgInfo.providerID) {
          // Fallback to top-level modelID/providerID
          info.model = {
            modelID: msgInfo.modelID,
            providerID: msgInfo.providerID,
          };
        }

        log.debug(LOG.TOOL, `Found caller model info`, {
          sessionId,
          agent: info.agent,
          modelID: info.model?.modelID,
          providerID: info.model?.providerID,
        });

        return info;
      }
    }

    log.debug(LOG.TOOL, `No assistant message found for session`, {
      sessionId,
    });
    return {};
  } catch (e) {
    log.warn(LOG.TOOL, `Failed to get caller model info`, {
      sessionId,
      error: String(e),
    });
    return {};
  }
}

// ============================================================================
// Broadcast Tool
// ============================================================================

export function createBroadcastTool(client: OpenCodeSessionClient) {
  return tool({
    description: BROADCAST_DESCRIPTION,
    args: {
      send_to: tool.schema
        .string()
        .optional()
        .describe("Target agent (single agent only). Omit to send to all."),
      message: tool.schema.string().describe("Your message"),
      reply_to: tool.schema
        .number()
        .optional()
        .describe("Message ID to mark as handled"),
    },
    async execute(args, context: ToolContext) {
      const sessionId = context.sessionID;

      // Check if this is the first broadcast call (agent announcing themselves)
      const isFirstCall = !announcedSessions.has(sessionId);

      // Register if not already (should already be registered via system.transform)
      registerSession(sessionId);

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
        messageContent =
          messageContent.substring(0, MAX_MESSAGE_LENGTH) + "... [truncated]";
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
      const isTargetingParent =
        parentId && recipientSessions.includes(parentId);

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
        const recipientState = sessionStates.get(recipientSessionId);

        log.debug(LOG.TOOL, `Checking recipient state`, {
          recipientSessionId,
          recipientAlias: validTargets[i],
          hasState: !!recipientState,
          status: recipientState?.status,
        });

        // Always store the message in inbox first
        sendMessage(alias, recipientSessionId, messageContent);

        // If recipient is idle, also resume the session
        if (recipientState?.status === "idle") {
          const resumed = await resumeSessionWithBroadcast(
            recipientSessionId,
            alias,
            messageContent,
          );
          if (resumed) {
            resumedSessions.push(validTargets[i]);
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
        log.info(
          LOG.MESSAGE,
          `Broadcasting to parent session, calling notify_once`,
          { sessionId, parentId },
        );
        try {
          const internalClient = (
            client as unknown as { _client?: InternalClient }
          )._client;
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

      return broadcastResult(
        alias,
        validTargets,
        parallelAgents,
        handledMessage,
      );
    },
  });
}

// ============================================================================
// Subagent Tool
// ============================================================================

export function createSubagentTool(client: OpenCodeSessionClient) {
  return tool({
    description: SUBAGENT_DESCRIPTION,
    args: {
      prompt: tool.schema
        .string()
        .describe("The task for the new agent to perform"),
      description: tool.schema
        .string()
        .optional()
        .describe("Short description of the task (3-5 words)"),
    },
    async execute(args, context: ToolContext) {
      const sessionId = context.sessionID;

      if (!args.prompt) {
        log.warn(LOG.TOOL, `subagent missing 'prompt'`, { sessionId });
        return SUBAGENT_MISSING_PROMPT;
      }

      // Get parent session ID - subagent will be a sibling (child of parent)
      const parentId = await getParentId(client, sessionId);
      if (!parentId) {
        log.warn(LOG.TOOL, `subagent called from non-child session`, {
          sessionId,
        });
        return SUBAGENT_NOT_CHILD_SESSION;
      }

      const callerAlias = getAlias(sessionId);
      const description = args.description || args.prompt.substring(0, 50);

      log.info(LOG.TOOL, `subagent called`, {
        callerAlias,
        parentId,
        descriptionLength: description.length,
        promptLength: args.prompt.length,
      });

      try {
        // Create a sibling session (child of the same parent as caller)
        const createResult = await client.session.create({
          body: {
            parentID: parentId,
            title: `${description} (subagent from ${callerAlias})`,
          },
        });

        const newSessionId = createResult.data?.id;
        if (!newSessionId) {
          log.error(LOG.TOOL, `subagent failed to create session`, {
            callerAlias,
          });
          return SUBAGENT_CREATE_FAILED;
        }

        // Pre-register the new session so it can immediately use broadcast
        registerSession(newSessionId);
        const newAlias = getAlias(newSessionId);

        // Create isolated worktree for this agent (if enabled and in a git repo)
        if (isWorktreeEnabled()) {
          const worktreePath = await createAgentWorktree(
            newAlias,
            process.cwd(),
          );
          if (worktreePath) {
            setWorktree(newSessionId, worktreePath);
          }
        }

        log.info(LOG.TOOL, `subagent created session`, {
          callerAlias,
          newAlias,
          newSessionId,
          parentId,
        });

        // Inject task part into parent session BEFORE starting
        const subagentInfo: SubagentInfo = {
          sessionId: newSessionId,
          alias: newAlias,
          description,
          prompt: args.prompt,
          timestamp: Date.now(),
          injected: false,
          parentSessionId: parentId,
        };

        // Track that the CALLER has a pending subagent
        let callerSubagents = callerPendingSubagents.get(sessionId);
        if (!callerSubagents) {
          callerSubagents = new Set();
          callerPendingSubagents.set(sessionId, callerSubagents);
        }
        callerSubagents.add(newSessionId);
        log.info(LOG.TOOL, `subagent tracked for caller`, {
          callerSessionId: sessionId,
          callerAlias,
          subagentSessionId: newSessionId,
          totalPendingSubagents: callerSubagents.size,
        });

        // Try to inject immediately into parent's message history
        const injected = await injectTaskPartToParent(
          client,
          parentId,
          subagentInfo,
        );

        if (injected) {
          subagentInfo.injected = true;
          activeSubagents.set(newSessionId, subagentInfo);
          log.info(LOG.TOOL, `subagent task injected to parent TUI`, {
            parentId,
            newAlias,
            partId: subagentInfo.partId,
          });
        } else {
          // Store for completion tracking anyway
          activeSubagents.set(newSessionId, subagentInfo);
          log.info(LOG.TOOL, `subagent stored for completion injection`, {
            parentId,
            newAlias,
          });
        }

        // Start the session WITHOUT blocking (fire-and-forget)
        log.info(LOG.TOOL, `subagent starting session (non-blocking)`, {
          newAlias,
          newSessionId,
        });

        // Get caller's agent/model to inherit
        const callerModelInfo = await getCallerModelInfo(client, sessionId);

        log.info(LOG.TOOL, `subagent inheriting caller's agent/model`, {
          callerAlias,
          agent: callerModelInfo.agent,
          modelID: callerModelInfo.model?.modelID,
          providerID: callerModelInfo.model?.providerID,
        });

        // Fire and forget - don't await the prompt
        client.session
          .prompt({
            path: { id: newSessionId },
            body: {
              parts: [{ type: "text", text: args.prompt }],
              agent: callerModelInfo.agent,
              model: callerModelInfo.model,
            },
          })
          .then(async (result) => {
            const resultAny = result as { data?: unknown; error?: unknown };
            if (resultAny.error) {
              log.error(LOG.TOOL, `subagent prompt failed`, {
                newAlias,
                error: JSON.stringify(resultAny.error),
              });
            } else {
              log.info(LOG.TOOL, `subagent completed (async)`, {
                newAlias,
                newSessionId,
              });
            }

            // Subagent session completed - handle completion:

            // 1. Fetch the output from subagent session
            const subagentOutput = await fetchSubagentOutput(
              client,
              newSessionId,
              newAlias,
            );

            // 1.5. Save to history for recall tool
            saveAgentToHistory(newAlias, subagentOutput);

            // 2. Mark session as idle in sessionStates (enables resume)
            sessionStates.set(newSessionId, {
              sessionId: newSessionId,
              alias: newAlias,
              status: "idle",
              lastActivity: Date.now(),
            });
            log.info(LOG.SESSION, `Subagent session marked idle`, {
              newSessionId,
              newAlias,
            });

            // 3. Mark the subagent as completed in the parent TUI
            const subagent = activeSubagents.get(newSessionId);
            if (subagent) {
              await markSubagentCompleted(client, subagent);
            }

            // 3.5. Keep worktree - agent's changes are preserved
            // User can manually merge changes from .worktrees/<alias>
            const subagentWorktree = getWorktree(newSessionId);
            if (subagentWorktree) {
              log.info(LOG.TOOL, `Worktree preserved with agent's changes`, {
                alias: newAlias,
                worktree: subagentWorktree,
              });
            }

            // 4. Pipe the subagent output to the caller
            const callerState = sessionStates.get(sessionId);
            const callerAliasForPipe =
              sessionToAlias.get(sessionId) || "caller";

            log.info(LOG.TOOL, `subagent completed, still tracked for caller`, {
              callerSessionId: sessionId,
              subagentSessionId: newSessionId,
              callerAlias: callerAliasForPipe,
            });

            // Create a summary message with the subagent output
            const outputMessage = receivedSubagentOutput(newAlias, subagentOutput);

            // Check config: true = inbox mode (forced attention), false = user message mode
            const useInboxMode = isSubagentResultForcedAttention();

            if (useInboxMode) {
              // Inbox mode: output appears in synthetic broadcast injection
              if (callerState?.status === "idle") {
                // Caller is idle - resume with the output via broadcast
                log.info(
                  LOG.TOOL,
                  `Piping subagent output to idle caller via broadcast resume`,
                  {
                    callerSessionId: sessionId,
                    callerAlias: callerAliasForPipe,
                    subagentAlias: newAlias,
                  },
                );
                resumeSessionWithBroadcast(
                  sessionId,
                  newAlias,
                  outputMessage,
                ).catch((e) =>
                  log.error(
                    LOG.TOOL,
                    `Failed to pipe subagent output to caller`,
                    {
                      error: String(e),
                    },
                  ),
                );
              } else {
                // Caller is still active - add to inbox for next synthetic injection
                log.info(
                  LOG.TOOL,
                  `Piping subagent output to active caller via inbox`,
                  {
                    callerSessionId: sessionId,
                    callerAlias: callerAliasForPipe,
                    subagentAlias: newAlias,
                  },
                );
                sendMessage(newAlias, sessionId, outputMessage);
              }
            } else {
              // User message mode: output injected as resumePrompt via session.before_complete
              // NOTE: This currently waits until caller finishes current work - see TODO
              log.info(
                LOG.TOOL,
                `Storing subagent output for user message injection`,
                {
                  callerSessionId: sessionId,
                  callerAlias: callerAliasForPipe,
                  subagentAlias: newAlias,
                },
              );
              resumeWithSubagentOutput(
                sessionId,
                newAlias,
                subagentOutput,
              ).catch((e) =>
                log.error(
                  LOG.TOOL,
                  `Failed to store subagent output for user message`,
                  {
                    error: String(e),
                  },
                ),
              );
            }

            // 5. Check for unread messages and resume subagent session if needed
            const unreadMessages = getMessagesNeedingResume(newSessionId);
            if (unreadMessages.length > 0) {
              log.info(
                LOG.SESSION,
                `Subagent session has unread messages, resuming`,
                {
                  newSessionId,
                  newAlias,
                  unreadCount: unreadMessages.length,
                },
              );
              const firstUnread = unreadMessages[0];
              markMessagesAsPresented(newSessionId, [firstUnread.msgIndex]);
              resumeSessionWithBroadcast(
                newSessionId,
                firstUnread.from,
                firstUnread.body,
              ).catch((e) =>
                log.error(LOG.SESSION, `Failed to resume subagent session`, {
                  error: String(e),
                }),
              );
            }
          })
          .catch((err: unknown) => {
            log.error(LOG.TOOL, `subagent prompt error`, {
              newAlias,
              error: String(err),
            });
          });

        // Return immediately - caller can continue working
        return subagentResult(newAlias, newSessionId, description);
      } catch (e) {
        log.error(LOG.TOOL, `subagent failed`, {
          callerAlias,
          error: String(e),
        });
        return subagentError(String(e));
      }
    },
  });
}

// ============================================================================
// Recall Tool
// ============================================================================

export function createRecallTool() {
  return tool({
    description: RECALL_DESCRIPTION,
    args: {
      agent_name: tool.schema
        .string()
        .optional()
        .describe(
          "Specific agent to recall (e.g., 'agentA'). Omit to get all agents.",
        ),
      show_output: tool.schema
        .boolean()
        .optional()
        .describe(
          "Include the agent's final output. Only works when agent_name is specified.",
        ),
    },
    async execute(args, context: ToolContext) {
      const sessionId = context.sessionID;
      const alias = getAlias(sessionId);

      log.info(LOG.TOOL, `recall called`, {
        alias,
        targetAgent: args.agent_name || "all",
        showOutput: args.show_output || false,
      });

      const result = recallAgents(args.agent_name, args.show_output);

      if (result.agents.length === 0) {
        if (args.agent_name) {
          return recallNotFound(args.agent_name);
        }
        return RECALL_EMPTY;
      }

      // Format nicely for LLM
      return JSON.stringify(result, null, 2);
    },
  });
}
