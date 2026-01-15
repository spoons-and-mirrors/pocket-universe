// =============================================================================
// Tool definitions: broadcast and spawn
// =============================================================================

import { tool } from "@opencode-ai/plugin";
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  BROADCAST_SELF_MESSAGE,
  broadcastUnknownRecipient,
  broadcastResult,
  SPAWN_DESCRIPTION,
  SPAWN_NOT_CHILD_SESSION,
  SPAWN_MISSING_PROMPT,
  spawnResult,
  type HandledMessage,
} from "./prompt";
import { log, LOG } from "./logger";
import type { OpenCodeSessionClient, ToolContext, SpawnInfo } from "./types";
import {
  sessionToAlias,
  aliasToSession,
  sessionStates,
  announcedSessions,
  activeSpawns,
  callerPendingSpawns,
  getAlias,
  setDescription,
  resolveAlias,
  registerSession,
  MAX_MESSAGE_LENGTH,
  setWorktree,
  getWorktree,
  removeWorktree,
} from "./state";
import {
  sendMessage,
  resumeSessionWithBroadcast,
  resumeWithSpawnOutput,
  getMessagesNeedingResume,
  markMessagesAsHandled,
  markMessagesAsPresented,
  getKnownAliases,
  getParallelAgents,
  getParentId,
  injectTaskPartToParent,
  fetchSpawnOutput,
  markSpawnCompleted,
} from "./messaging";
import type { InternalClient } from "./types";
import { createAgentWorktree, removeAgentWorktree } from "./worktree";
import { isWorktreeEnabled, isSpawnResultForcedAttention } from "./config";

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

      // First call logic: announce the agent
      // BUT if reply_to is provided, skip status announcement and treat as normal reply
      if (isFirstCall && args.reply_to === undefined) {
        // Mark this session as having announced
        announcedSessions.add(sessionId);

        // Update status - this is the agent's first announcement
        setDescription(sessionId, messageContent);

        const knownAgents = getKnownAliases(sessionId);

        log.info(LOG.TOOL, `First broadcast - status announcement`, {
          alias,
          status: messageContent.substring(0, 80),
          discoveredAgents: knownAgents,
        });

        // Check if any discovered agents are idle and resume them
        for (const knownAlias of knownAgents) {
          const knownSessionId = aliasToSession.get(knownAlias);
          if (knownSessionId) {
            const knownState = sessionStates.get(knownSessionId);
            if (knownState?.status === "idle") {
              log.info(LOG.TOOL, `Resuming idle agent on status announcement`, {
                announcer: alias,
                idleAgent: knownAlias,
              });
              resumeSessionWithBroadcast(
                knownSessionId,
                alias,
                messageContent,
              ).catch((e) =>
                log.error(LOG.TOOL, `Failed to resume on announcement`, {
                  error: String(e),
                }),
              );
            }
          }
        }

        return broadcastResult(alias, knownAgents, parallelAgents, undefined);
      }

      // If first call but has reply_to, still mark as announced but process as normal reply
      if (isFirstCall) {
        announcedSessions.add(sessionId);
        log.info(
          LOG.TOOL,
          `First broadcast with reply_to - treating as normal reply`,
          {
            alias,
            reply_to: args.reply_to,
          },
        );
      }

      // Handle reply_to - mark message as handled and auto-wire recipient
      let handledMessage: HandledMessage | undefined;
      let autoRecipient: string | undefined;
      if (args.reply_to !== undefined) {
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
        // Update this agent's status and return early (no messages queued)
        // NOTE: Does NOT resume idle agents - status updates are passive visibility
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
                text: `[Pocket Universe] Message from ${alias}: ${args.message}`,
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
// Spawn Tool
// ============================================================================

export function createSpawnTool(client: OpenCodeSessionClient) {
  return tool({
    description: SPAWN_DESCRIPTION,
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
        log.warn(LOG.TOOL, `spawn missing 'prompt'`, { sessionId });
        return SPAWN_MISSING_PROMPT;
      }

      // Get parent session ID - spawned agent will be a sibling (child of parent)
      const parentId = await getParentId(client, sessionId);
      if (!parentId) {
        log.warn(LOG.TOOL, `spawn called from non-child session`, {
          sessionId,
        });
        return SPAWN_NOT_CHILD_SESSION;
      }

      const callerAlias = getAlias(sessionId);
      const description = args.description || args.prompt.substring(0, 50);

      log.info(LOG.TOOL, `spawn called`, {
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
            title: `${description} (spawned by ${callerAlias})`,
          },
        });

        const newSessionId = createResult.data?.id;
        if (!newSessionId) {
          log.error(LOG.TOOL, `spawn failed to create session`, {
            callerAlias,
          });
          return `Error: Failed to create session. No session ID returned.`;
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

        log.info(LOG.TOOL, `spawn created session`, {
          callerAlias,
          newAlias,
          newSessionId,
          parentId,
        });

        // Inject task part into parent session BEFORE starting
        const spawnInfo: SpawnInfo = {
          sessionId: newSessionId,
          alias: newAlias,
          description,
          prompt: args.prompt,
          timestamp: Date.now(),
          injected: false,
          parentSessionId: parentId,
        };

        // Track that the CALLER has a pending spawn
        let callerSpawns = callerPendingSpawns.get(sessionId);
        if (!callerSpawns) {
          callerSpawns = new Set();
          callerPendingSpawns.set(sessionId, callerSpawns);
        }
        callerSpawns.add(newSessionId);
        log.info(LOG.TOOL, `spawn tracked for caller`, {
          callerSessionId: sessionId,
          callerAlias,
          spawnedSessionId: newSessionId,
          totalPendingSpawns: callerSpawns.size,
        });

        // Try to inject immediately into parent's message history
        const injected = await injectTaskPartToParent(
          client,
          parentId,
          spawnInfo,
        );

        if (injected) {
          spawnInfo.injected = true;
          activeSpawns.set(newSessionId, spawnInfo);
          log.info(LOG.TOOL, `spawn task injected to parent TUI`, {
            parentId,
            newAlias,
            partId: spawnInfo.partId,
          });
        } else {
          // Store for completion tracking anyway
          activeSpawns.set(newSessionId, spawnInfo);
          log.info(LOG.TOOL, `spawn stored for completion injection`, {
            parentId,
            newAlias,
          });
        }

        // Start the session WITHOUT blocking (fire-and-forget)
        log.info(LOG.TOOL, `spawn starting session (non-blocking)`, {
          newAlias,
          newSessionId,
        });

        // Fire and forget - don't await the prompt
        client.session
          .prompt({
            path: { id: newSessionId },
            body: {
              parts: [{ type: "text", text: args.prompt }],
            },
          })
          .then(async (result) => {
            const resultAny = result as { data?: unknown; error?: unknown };
            if (resultAny.error) {
              log.error(LOG.TOOL, `spawn prompt failed`, {
                newAlias,
                error: JSON.stringify(resultAny.error),
              });
            } else {
              log.info(LOG.TOOL, `spawn agent completed (async)`, {
                newAlias,
                newSessionId,
              });
            }

            // Spawned session completed - handle completion:

            // 1. Fetch the output from spawned session
            const spawnOutput = await fetchSpawnOutput(
              client,
              newSessionId,
              newAlias,
            );

            // 2. Mark session as idle in sessionStates (enables resume)
            sessionStates.set(newSessionId, {
              sessionId: newSessionId,
              alias: newAlias,
              status: "idle",
              lastActivity: Date.now(),
            });
            log.info(LOG.SESSION, `Spawned session marked idle`, {
              newSessionId,
              newAlias,
            });

            // 3. Mark the spawn as completed in the parent TUI
            const spawn = activeSpawns.get(newSessionId);
            if (spawn) {
              await markSpawnCompleted(client, spawn);
            }

            // 3.5. Keep worktree - agent's changes are preserved
            // User can manually merge changes from .worktrees/<alias>
            const spawnWorktree = getWorktree(newSessionId);
            if (spawnWorktree) {
              log.info(LOG.TOOL, `Worktree preserved with agent's changes`, {
                alias: newAlias,
                worktree: spawnWorktree,
              });
            }

            // 4. Pipe the spawn output to the caller
            const callerState = sessionStates.get(sessionId);
            const callerAliasForPipe =
              sessionToAlias.get(sessionId) || "caller";

            log.info(LOG.TOOL, `spawn completed, still tracked for caller`, {
              callerSessionId: sessionId,
              spawnedSessionId: newSessionId,
              callerAlias: callerAliasForPipe,
            });

            // Create a summary message with the spawn output
            const outputMessage = `[Received ${newAlias} completed task]\n${spawnOutput}`;

            // Check if forced attention mode is enabled (flag false = forced attention)
            const useForcedAttention = !isSpawnResultForcedAttention();

            if (useForcedAttention) {
              // Forced attention: inject spawn output as persisted user message
              log.info(
                LOG.TOOL,
                `Piping spawn output via forced attention (persisted user message)`,
                {
                  callerSessionId: sessionId,
                  callerAlias: callerAliasForPipe,
                  spawnAlias: newAlias,
                },
              );
              resumeWithSpawnOutput(sessionId, newAlias, spawnOutput).catch(
                (e) =>
                  log.error(
                    LOG.TOOL,
                    `Failed to pipe spawn output (forced attention)`,
                    {
                      error: String(e),
                    },
                  ),
              );
            } else if (callerState?.status === "idle") {
              // Caller is idle - resume with the output via message queue
              log.info(
                LOG.TOOL,
                `Piping spawn output to idle caller via resume`,
                {
                  callerSessionId: sessionId,
                  callerAlias: callerAliasForPipe,
                  spawnAlias: newAlias,
                },
              );
              resumeSessionWithBroadcast(
                sessionId,
                newAlias,
                outputMessage,
              ).catch((e) =>
                log.error(LOG.TOOL, `Failed to pipe spawn output to caller`, {
                  error: String(e),
                }),
              );
            } else {
              // Caller is still active - send as broadcast message
              log.info(
                LOG.TOOL,
                `Piping spawn output to active caller via message`,
                {
                  callerSessionId: sessionId,
                  callerAlias: callerAliasForPipe,
                  spawnAlias: newAlias,
                },
              );
              sendMessage(newAlias, sessionId, outputMessage);
            }

            // 5. Check for unread messages and resume spawned session if needed
            const unreadMessages = getMessagesNeedingResume(newSessionId);
            if (unreadMessages.length > 0) {
              log.info(
                LOG.SESSION,
                `Spawned session has unread messages, resuming`,
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
                log.error(LOG.SESSION, `Failed to resume spawned session`, {
                  error: String(e),
                }),
              );
            }
          })
          .catch((err: unknown) => {
            log.error(LOG.TOOL, `spawn prompt error`, {
              newAlias,
              error: String(err),
            });
          });

        // Return immediately - caller can continue working
        return spawnResult(newAlias, newSessionId, description);
      } catch (e) {
        log.error(LOG.TOOL, `spawn failed`, {
          callerAlias,
          error: String(e),
        });
        return `Error: Failed to spawn agent: ${String(e)}`;
      }
    },
  });
}
