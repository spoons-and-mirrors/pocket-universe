import type { Plugin } from "@opencode-ai/plugin";
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
  SYSTEM_PROMPT,
  type HandledMessage,
} from "./prompt";
import { log, LOG } from "./logger";
import type {
  OpenCodeSessionClient,
  ToolContext,
  ToolExecuteInput,
  ToolExecuteOutput,
  SystemTransformInput,
  SystemTransformOutput,
  MessagesTransformOutput,
  ConfigTransformOutput,
  UserMessage,
  SpawnInfo,
  InternalClient,
} from "./types";
import {
  sessionToAlias,
  aliasToSession,
  sessionStates,
  announcedSessions,
  pendingTaskDescriptions,
  pendingSpawns,
  activeSpawns,
  callerPendingSpawns,
  setStoredClient,
  getAlias,
  setDescription,
  resolveAlias,
  registerSession,
  MAX_MESSAGE_LENGTH,
} from "./state";
import {
  sendMessage,
  resumeSessionWithBroadcast,
  getUnhandledMessages,
  getMessagesNeedingResume,
  markMessagesAsHandled,
  markMessagesAsPresented,
  getKnownAliases,
  getParallelAgents,
  getParentId,
  isChildSession,
  createInboxMessage,
  createSpawnTaskMessage,
  injectTaskPartToParent,
  fetchSpawnOutput,
  markSpawnCompleted,
} from "./messaging";

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized");
  const client = ctx.client as unknown as OpenCodeSessionClient;

  // Store client for resumption calls
  setStoredClient(client);

  return {
    // Allow main session to wait for spawned grandchild sessions AND resumed sessions
    "session.before_complete": async (
      input: { sessionID: string; parentSessionID?: string },
      output: { waitForSessions: string[]; resumePrompt?: string },
    ) => {
      const alias = sessionToAlias.get(input.sessionID) || "unknown";

      // Helper to wait for a session to become idle
      const waitForSessionIdle = (targetSessionId: string): Promise<void> => {
        return new Promise((resolve) => {
          const checkIdle = () => {
            const state = sessionStates.get(targetSessionId);
            if (state?.status === "idle") {
              resolve();
              return true;
            }
            return false;
          };

          // Check immediately
          if (checkIdle()) return;

          // Poll every 100ms (sessionStates is updated when sessions go idle)
          const interval = setInterval(() => {
            if (checkIdle()) {
              clearInterval(interval);
            }
          }, 100);

          // Timeout after 5 minutes to prevent infinite wait
          setTimeout(
            () => {
              clearInterval(interval);
              resolve();
            },
            5 * 60 * 1000,
          );
        });
      };

      // Loop until all spawns complete AND no pending resumes
      let iteration = 0;
      while (iteration < 100) {
        // Safety limit
        iteration++;

        // 1. Check for pending spawns
        const pending = callerPendingSpawns.get(input.sessionID);
        if (pending && pending.size > 0) {
          const spawnIds = Array.from(pending);
          log.info(
            LOG.SESSION,
            `session.before_complete: waiting for spawns (iteration ${iteration})`,
            {
              sessionID: input.sessionID,
              alias,
              pendingSpawnCount: spawnIds.length,
              pendingSpawnIds: spawnIds,
            },
          );

          // Wait for all pending spawns to become idle
          await Promise.all(spawnIds.map(waitForSessionIdle));

          // Check which spawns are truly done (idle AND no unread messages)
          // If a spawn has unread messages, it will be resumed (via auto-resume logic in its own thread)
          // so we must keep waiting for it.
          const doneSpawns = spawnIds.filter((id) => {
            const unread = getMessagesNeedingResume(id);
            return unread.length === 0;
          });

          // Remove truly done spawns
          for (const doneId of doneSpawns) {
            pending.delete(doneId);
          }

          // If pendingSpawns is empty, clean up the map entry
          if (pending.size === 0) {
            callerPendingSpawns.delete(input.sessionID);
          }

          log.info(LOG.SESSION, `session.before_complete: spawns checked`, {
            sessionID: input.sessionID,
            alias,
            totalSpawns: spawnIds.length,
            doneSpawns: doneSpawns.length,
            remainingSpawns: pending.size,
          });

          // Continue loop to check for messages that may have arrived
          continue;
        }

        // 2. Check for unread messages (may have been piped from completed spawns)
        const unreadMessages = getMessagesNeedingResume(input.sessionID);
        if (unreadMessages.length > 0) {
          log.info(
            LOG.SESSION,
            `session.before_complete: has unread messages, setting resumePrompt`,
            {
              sessionID: input.sessionID,
              alias,
              unreadCount: unreadMessages.length,
            },
          );

          // Mark the message as presented so we don't loop forever
          const firstUnread = unreadMessages[0];
          markMessagesAsPresented(input.sessionID, [firstUnread.msgIndex]);

          // Tell OpenCode to resume this session with the given prompt
          // OpenCode will:
          // 1. Complete this hook
          // 2. Start a new prompt with resumePrompt
          // 3. Wait for that prompt to complete
          // 4. Then session.before_complete fires again (recursively)
          // This avoids the deadlock of calling prompt() from within the hook
          output.resumePrompt = `[Broadcast from ${firstUnread.from}]: New message received. Check your inbox.`;

          log.info(
            LOG.SESSION,
            `session.before_complete: resumePrompt set, breaking loop`,
            {
              sessionID: input.sessionID,
              alias,
            },
          );

          // Break out - OpenCode will handle the resume and call this hook again
          break;
        }

        // Nothing pending - we're done
        log.info(LOG.SESSION, `session.before_complete: all done`, {
          sessionID: input.sessionID,
          alias,
          iterations: iteration,
        });
        break;
      }
    },

    // Track session idle events for broadcast resumption AND spawn completion
    "session.idle": async ({ sessionID }: { sessionID: string }) => {
      // Check if this is a registered Pocket Universe session (child session)
      const alias = sessionToAlias.get(sessionID);
      const hasPendingSpawns = callerPendingSpawns.has(sessionID);
      const pendingCount = callerPendingSpawns.get(sessionID)?.size || 0;

      log.info(LOG.SESSION, `session.idle hook fired`, {
        sessionID,
        alias: alias || "unknown",
        hasPendingSpawns,
        pendingSpawnCount: pendingCount,
      });

      if (alias) {
        sessionStates.set(sessionID, {
          sessionId: sessionID,
          alias,
          status: "idle",
          lastActivity: Date.now(),
        });
        log.info(LOG.SESSION, `Session marked idle`, { sessionID, alias });

        // Check if this is a spawned session that completed
        // If so, mark it as completed in the parent TUI
        const spawn = activeSpawns.get(sessionID);
        if (spawn) {
          log.info(LOG.SESSION, `Spawned session completed, marking done`, {
            sessionID,
            alias: spawn.alias,
          });
          // Fetch output and mark complete
          const output = await fetchSpawnOutput(client, sessionID, spawn.alias);
          await markSpawnCompleted(client, spawn, output);
        }
      } else {
        log.debug(LOG.SESSION, `session.idle for untracked session`, {
          sessionID,
        });
      }
    },

    // Track when task tools complete - mark subtask sessions as idle
    "tool.execute.after": async (
      input: ToolExecuteInput,
      output: ToolExecuteOutput,
    ) => {
      // Only care about task tool completions
      if (input.tool !== "task") return;

      // Get the subtask session ID from metadata
      const subtaskSessionId =
        output?.metadata?.sessionId || output?.metadata?.session_id;

      if (subtaskSessionId) {
        const alias = sessionToAlias.get(subtaskSessionId);
        if (alias) {
          // Check if this session has pending spawns
          const pending = callerPendingSpawns.get(subtaskSessionId);
          if (pending && pending.size > 0) {
            log.warn(
              LOG.SESSION,
              `Task completing but has pending spawns! Main will continue early.`,
              {
                subtaskSessionId,
                alias,
                pendingSpawnCount: pending.size,
                pendingSpawnIds: Array.from(pending),
              },
            );
          }

          sessionStates.set(subtaskSessionId, {
            sessionId: subtaskSessionId,
            alias,
            status: "idle",
            lastActivity: Date.now(),
          });
          log.info(LOG.SESSION, `Task completed, session marked idle`, {
            subtaskSessionId,
            alias,
          });

          // Check if there are unread messages for this session
          // If so, resume the session so it can process them
          const unreadMessages = getMessagesNeedingResume(subtaskSessionId);
          if (unreadMessages.length > 0) {
            log.info(
              LOG.SESSION,
              `Session has unread messages on idle, resuming`,
              {
                subtaskSessionId,
                alias,
                unreadCount: unreadMessages.length,
              },
            );

            // Resume with the first unread message
            const firstUnread = unreadMessages[0];
            const senderAlias = firstUnread.from;

            // Mark this message as presented BEFORE resuming to avoid infinite loop
            markMessagesAsPresented(subtaskSessionId, [firstUnread.msgIndex]);

            resumeSessionWithBroadcast(
              subtaskSessionId,
              senderAlias,
              firstUnread.body,
            ).catch((e) =>
              log.error(LOG.SESSION, `Failed to resume with unread message`, {
                error: String(e),
              }),
            );
          }
        } else {
          log.debug(LOG.SESSION, `Task completed for untracked session`, {
            subtaskSessionId,
          });
        }
      }
    },

    tool: {
      broadcast: tool({
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
              messageContent.substring(0, MAX_MESSAGE_LENGTH) +
              "... [truncated]";
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
                  log.info(
                    LOG.TOOL,
                    `Resuming idle agent on status announcement`,
                    {
                      announcer: alias,
                      idleAgent: knownAlias,
                    },
                  );
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

            return broadcastResult(
              alias,
              knownAgents,
              parallelAgents,
              undefined,
            );
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
                log.warn(
                  LOG.TOOL,
                  `reply_to provided - ignoring send_to param`,
                  {
                    alias,
                    providedSendTo: args.send_to,
                    autoWiredRecipient: autoRecipient,
                  },
                );
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
            // No target specified - send to all known agents
            targetAliases = knownAgents;
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
      }),

      spawn: tool({
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
                  await markSpawnCompleted(client, spawn, spawnOutput);
                }

                // 4. Pipe the spawn output to the caller
                const callerState = sessionStates.get(sessionId);
                const callerAliasForPipe =
                  sessionToAlias.get(sessionId) || "caller";

                log.info(
                  LOG.TOOL,
                  `spawn completed, still tracked for caller`,
                  {
                    callerSessionId: sessionId,
                    spawnedSessionId: newSessionId,
                    callerAlias: callerAliasForPipe,
                  },
                );

                // Create a summary message with the spawn output
                const outputMessage = `[Spawn completed: ${newAlias}]\n${spawnOutput}`;

                if (callerState?.status === "idle") {
                  // Caller is idle - resume with the output
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
                    log.error(
                      LOG.TOOL,
                      `Failed to pipe spawn output to caller`,
                      {
                        error: String(e),
                      },
                    ),
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
      }),
    },

    // Capture task description before execution
    "tool.execute.before": async (input: unknown, output: unknown) => {
      const typedInput = input as {
        tool: string;
        sessionID: string;
        callID: string;
      };
      const typedOutput = output as {
        args?: { description?: string; prompt?: string };
      };

      log.debug(LOG.HOOK, `tool.execute.before fired`, {
        tool: typedInput.tool,
        sessionID: typedInput.sessionID,
        hasArgs: !!typedOutput?.args,
        hasDescription: !!typedOutput?.args?.description,
      });

      if (typedInput.tool === "task" && typedOutput?.args?.description) {
        const description = typedOutput.args.description;
        const parentSessionId = typedInput.sessionID;

        // Store description keyed by parent session ID
        const existing = pendingTaskDescriptions.get(parentSessionId) || [];
        existing.push(description);
        pendingTaskDescriptions.set(parentSessionId, existing);

        log.info(LOG.HOOK, `Captured task description`, {
          parentSessionId,
          description: description.substring(0, 80),
          totalPending: existing.length,
        });
      }
    },

    // PRE-REGISTER agents on first LLM call + inject system prompt
    // Only for child sessions (those with parentID)
    "experimental.chat.system.transform": async (
      input: SystemTransformInput,
      output: SystemTransformOutput,
    ) => {
      const sessionId = input.sessionID;
      if (!sessionId) {
        log.debug(
          LOG.INJECT,
          `No sessionID in system.transform input, skipping`,
        );
        return;
      }

      // Only inject for child sessions (those with parentID)
      if (!(await isChildSession(client, sessionId))) {
        log.debug(
          LOG.INJECT,
          `Session has no parentID (main session), skipping Pocket Universe`,
          { sessionId },
        );
        return;
      }

      // Register child session early - before agent even calls broadcast
      registerSession(sessionId);

      // Check if there's a pending task description for this session's parent
      const parentId = await getParentId(client, sessionId);
      if (parentId) {
        const pending = pendingTaskDescriptions.get(parentId);
        if (pending && pending.length > 0) {
          // Use the first pending description for this child session
          const description = pending.shift()!;
          setDescription(sessionId, description);

          log.info(
            LOG.HOOK,
            `Applied task description as initial agent status`,
            {
              sessionId,
              alias: getAlias(sessionId),
              description: description.substring(0, 80),
              remainingPending: pending.length,
            },
          );

          // Clean up if empty
          if (pending.length === 0) {
            pendingTaskDescriptions.delete(parentId);
          }
        }
      }

      // Inject Pocket Universe instructions
      output.system.push(SYSTEM_PROMPT);
      log.info(
        LOG.INJECT,
        `Registered session and injected Pocket Universe system prompt`,
        {
          sessionId,
          alias: getAlias(sessionId),
        },
      );
    },

    // Inject ONE bundled inbox message at the END of the chain
    // Only for child sessions (those with parentID)
    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: MessagesTransformOutput,
    ) => {
      const lastUserMsg = [...output.messages]
        .reverse()
        .find((m) => m.info.role === "user");
      if (!lastUserMsg) {
        log.debug(
          LOG.INJECT,
          `No user message found in transform, skipping Pocket Universe injection`,
        );
        return;
      }

      const sessionId = lastUserMsg.info.sessionID;

      // Check for pending spawns that need to be injected into this session
      const spawns = pendingSpawns.get(sessionId) || [];
      const uninjectedSpawns = spawns.filter((s) => !s.injected);

      if (uninjectedSpawns.length > 0) {
        log.info(
          LOG.INJECT,
          `Injecting ${uninjectedSpawns.length} synthetic task(s) for spawns`,
          {
            sessionId,
            spawns: uninjectedSpawns.map((s) => s.alias),
          },
        );

        // Inject synthetic task tool results for each spawn
        for (const spawn of uninjectedSpawns) {
          const taskMsg = createSpawnTaskMessage(sessionId, spawn, lastUserMsg);
          output.messages.push(taskMsg as unknown as UserMessage);
          spawn.injected = true;

          log.info(LOG.INJECT, `Injected synthetic task for spawn`, {
            sessionId,
            spawnAlias: spawn.alias,
            spawnSessionId: spawn.sessionId,
          });
        }
      }

      // Only inject Pocket Universe broadcast/inbox for child sessions (those with parentID)
      if (!(await isChildSession(client, sessionId))) {
        log.debug(
          LOG.INJECT,
          `Skipping Pocket Universe inbox for main session`,
          {
            sessionId,
            injectedSpawns: uninjectedSpawns.length,
          },
        );
        return;
      }

      const unhandled = getUnhandledMessages(sessionId);
      const parallelAgents = getParallelAgents(sessionId);

      log.debug(LOG.INJECT, `Checking for messages in transform`, {
        sessionId,
        unhandledCount: unhandled.length,
        parallelAgentCount: parallelAgents.length,
      });

      // Inject if there are messages OR other agents to show
      if (unhandled.length === 0 && parallelAgents.length === 0) {
        log.info(LOG.INJECT, `No agents or messages to inject`, {
          sessionId,
          alias: getAlias(sessionId),
        });
        return;
      }

      log.info(LOG.INJECT, `Injecting synthetic broadcast`, {
        sessionId,
        alias: getAlias(sessionId),
        agentCount: parallelAgents.length,
        agents: parallelAgents.map((a) => a.alias),
        messageCount: unhandled.length,
        messageIds: unhandled.map((m) => m.msgIndex),
      });

      // Create ONE bundled message with all pending messages
      const hasAnnounced = announcedSessions.has(sessionId);
      const inboxMsg = createInboxMessage(
        sessionId,
        unhandled,
        lastUserMsg,
        parallelAgents,
        hasAnnounced,
      );

      // Mark all injected messages as "presented" to prevent double-delivery via resume
      if (unhandled.length > 0) {
        markMessagesAsPresented(
          sessionId,
          unhandled.map((m) => m.msgIndex),
        );
        log.debug(LOG.INJECT, `Marked injected messages as presented`, {
          sessionId,
          messageCount: unhandled.length,
        });
      }

      // Push at the END of the messages array (recency bias)
      output.messages.push(inboxMsg as unknown as UserMessage);
    },

    // Add broadcast and spawn to subagent_tools
    "experimental.config.transform": async (
      _input: unknown,
      output: ConfigTransformOutput,
    ) => {
      const experimental = output.experimental ?? {};
      const existingSubagentTools = experimental.subagent_tools ?? [];
      output.experimental = {
        ...experimental,
        subagent_tools: [...existingSubagentTools, "broadcast", "spawn"],
      };
      log.info(
        LOG.HOOK,
        `Added 'broadcast' and 'spawn' to experimental.subagent_tools`,
      );
    },
  };
};

export default plugin;
