import type { Plugin } from "@opencode-ai/plugin";
import {
  getSystemPrompt,
  resumeBroadcastPrompt,
  getWorktreeSystemPrompt,
} from "./prompt";
import { log, LOG } from "./logger";
import type {
  OpenCodeSessionClient,
  ToolExecuteInput,
  ToolExecuteOutput,
  SystemTransformInput,
  SystemTransformOutput,
  MessagesTransformOutput,
  ConfigTransformOutput,
  UserMessage,
  AssistantMessage,
} from "./types";
import {
  sessionToAlias,
  sessionStates,
  announcedSessions,
  summaryInjectedSessions,
  pendingTaskDescriptions,
  pendingSubagents,
  activeSubagents,
  callerPendingSubagents,
  mainSessionActiveChildren,
  completedFirstLevelChildren,
  pendingSubagentOutputs,
  setStoredClient,
  getAlias,
  setDescription,
  registerSession,
  getWorktree,
  setWorktree,
} from "./state";
import {
  resumeSessionWithBroadcast,
  getUnhandledMessages,
  getMessagesNeedingResume,
  markMessagesAsPresented,
  getParallelAgents,
  getParentId,
  isChildSession,
  createInboxMessage,
  createSubagentTaskMessage,
  createWorktreeSummaryMessage,
  fetchSubagentOutput,
  markSubagentCompleted,
} from "./messaging";
import {
  injectPocketUniverseSummaryToMain,
  createSummaryCoverMessage,
} from "./injection";
import {
  createBroadcastTool,
  createSubagentTool,
  createRecallTool,
} from "./tools";
import { createAgentWorktree } from "./worktree";
import {
  isSubagentEnabled,
  isRecallEnabled,
  isWorktreeEnabled,
} from "./config";

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized");
  const client = ctx.client as unknown as OpenCodeSessionClient;

  // Store client for resumption calls
  setStoredClient(client);

  return {
    // Allow main session to wait for subagent grandchild sessions AND resumed sessions
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

      // Loop until all subagents complete AND no pending resumes
      let iteration = 0;
      while (iteration < 100) {
        // Safety limit
        iteration++;

        // 1. Check for pending subagents
        const pending = callerPendingSubagents.get(input.sessionID);
        if (pending && pending.size > 0) {
          const subagentIds = Array.from(pending);
          log.info(
            LOG.SESSION,
            `session.before_complete: waiting for subagents (iteration ${iteration})`,
            {
              sessionID: input.sessionID,
              alias,
              pendingSubagentCount: subagentIds.length,
              pendingSubagentIds: subagentIds,
            },
          );

          // Wait for all pending subagents to become idle
          await Promise.all(subagentIds.map(waitForSessionIdle));

          // Check which subagents are truly done (idle AND no unread messages)
          // If a subagent has unread messages, it will be resumed (via auto-resume logic in its own thread)
          // so we must keep waiting for it.
          const doneSubagents = subagentIds.filter((id) => {
            const unread = getMessagesNeedingResume(id);
            return unread.length === 0;
          });

          // Remove truly done subagents
          for (const doneId of doneSubagents) {
            pending.delete(doneId);
          }

          // If pendingSubagents is empty, clean up the map entry
          if (pending.size === 0) {
            callerPendingSubagents.delete(input.sessionID);
          }

          log.info(LOG.SESSION, `session.before_complete: subagents checked`, {
            sessionID: input.sessionID,
            alias,
            totalSubagents: subagentIds.length,
            doneSubagents: doneSubagents.length,
            remainingSubagents: pending.size,
          });

          // Continue loop to check for messages that may have arrived
          continue;
        }

        // 2. Check for pending subagent outputs (no forced attention mode)
        // These are stored by resumeWithSubagentOutput() when subagents complete
        const pendingOutput = pendingSubagentOutputs.get(input.sessionID);
        if (pendingOutput) {
          // Remove from pending to avoid infinite loop
          pendingSubagentOutputs.delete(input.sessionID);

          log.info(
            LOG.SESSION,
            `session.before_complete: has pending subagent output, setting resumePrompt`,
            {
              sessionID: input.sessionID,
              alias,
              senderAlias: pendingOutput.senderAlias,
              outputLength: pendingOutput.output.length,
            },
          );

          // Set resumePrompt - OpenCode will resume with this as a user message
          output.resumePrompt = pendingOutput.output;

          log.info(
            LOG.SESSION,
            `session.before_complete: resumePrompt set for subagent output, breaking loop`,
            {
              sessionID: input.sessionID,
              alias,
            },
          );

          // Break out - OpenCode will handle the resume and call this hook again
          break;
        }

        // 3. Check for unread messages (may have been piped from completed spawns)
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
          output.resumePrompt = resumeBroadcastPrompt(firstUnread.from);

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

        // Check if this is a first-level child returning to main session
        // If so, inject the Pocket Universe Summary to the main session
        // BUT only when ALL first-level children are done
        const parentId = await getParentId(client, input.sessionID);
        if (parentId && !summaryInjectedSessions.has(parentId)) {
          // Check if parent is a main session (has no grandparent)
          const grandparentId = await getParentId(client, parentId);
          if (!grandparentId) {
            // This is a first-level child, parent is main session
            // Remove this child from active tracking
            const children = mainSessionActiveChildren.get(parentId);
            if (children) {
              children.delete(input.sessionID);

              // Mark this child as completed so it doesn't get re-added
              let completed = completedFirstLevelChildren.get(parentId);
              if (!completed) {
                completed = new Set();
                completedFirstLevelChildren.set(parentId, completed);
              }
              completed.add(input.sessionID);

              log.info(LOG.SESSION, `First-level child completed`, {
                childSessionId: input.sessionID,
                mainSessionId: parentId,
                alias,
                remainingChildren: children.size,
              });

              // Only inject summary when ALL children are done
              if (children.size === 0) {
                mainSessionActiveChildren.delete(parentId);

                log.info(
                  LOG.SESSION,
                  `All first-level children complete, injecting Pocket Universe Summary to main`,
                  {
                    lastChildSessionId: input.sessionID,
                    mainSessionId: parentId,
                    alias,
                  },
                );

                // Mark as injected to prevent duplicates
                summaryInjectedSessions.add(parentId);

                // Inject the summary (fire and forget - don't block completion)
                injectPocketUniverseSummaryToMain(parentId).catch((e) =>
                  log.error(LOG.SESSION, `Failed to inject summary to main`, {
                    error: String(e),
                  }),
                );
              }
            } else {
              // No tracking found - this shouldn't happen but handle gracefully
              // Fall back to original behavior (inject immediately)
              log.warn(
                LOG.SESSION,
                `No active children tracking found for main session, injecting summary`,
                {
                  childSessionId: input.sessionID,
                  mainSessionId: parentId,
                  alias,
                },
              );

              summaryInjectedSessions.add(parentId);
              injectPocketUniverseSummaryToMain(parentId).catch((e) =>
                log.error(LOG.SESSION, `Failed to inject summary to main`, {
                  error: String(e),
                }),
              );
            }
          }
        }

        break;
      }
    },

    // Track session idle events for broadcast resumption AND subagent completion
    "session.idle": async ({ sessionID }: { sessionID: string }) => {
      // Check if this is a registered Pocket Universe session (child session)
      const alias = sessionToAlias.get(sessionID);
      const hasPendingSubagents = callerPendingSubagents.has(sessionID);
      const pendingCount = callerPendingSubagents.get(sessionID)?.size || 0;

      log.info(LOG.SESSION, `session.idle hook fired`, {
        sessionID,
        alias: alias || "unknown",
        hasPendingSubagents,
        pendingSubagentCount: pendingCount,
      });

      if (alias) {
        sessionStates.set(sessionID, {
          sessionId: sessionID,
          alias,
          status: "idle",
          lastActivity: Date.now(),
        });
        log.info(LOG.SESSION, `Session marked idle`, { sessionID, alias });

        // Check if this is a subagent session that completed
        // If so, mark it as completed in the parent TUI
        const subagent = activeSubagents.get(sessionID);
        if (subagent) {
          log.info(LOG.SESSION, `Subagent session completed, marking done`, {
            sessionID,
            alias: subagent.alias,
          });
          // Fetch output and mark complete
          await fetchSubagentOutput(client, sessionID, subagent.alias);
          await markSubagentCompleted(client, subagent);
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
          // Check if this session has pending subagents
          const pending = callerPendingSubagents.get(subtaskSessionId);
          if (pending && pending.size > 0) {
            log.warn(
              LOG.SESSION,
              `Task completing but has pending subagents! Main will continue early.`,
              {
                subtaskSessionId,
                alias,
                pendingSubagentCount: pending.size,
                pendingSubagentIds: Array.from(pending),
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
      broadcast: createBroadcastTool(client),
      // Only register recall tool if enabled in config
      ...(isRecallEnabled() ? { recall: createRecallTool() } : {}),
      // Only register subagent tool if enabled in config
      ...(isSubagentEnabled() ? { subagent: createSubagentTool(client) } : {}),
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

      // Create worktree if enabled and not already created (for native task children)
      // Spawned children already have worktrees created in spawn tool
      let agentWorktree = getWorktree(sessionId);
      if (isWorktreeEnabled() && !agentWorktree) {
        const alias = getAlias(sessionId);
        const newWorktree = await createAgentWorktree(alias, process.cwd());
        if (newWorktree) {
          setWorktree(sessionId, newWorktree);
          agentWorktree = newWorktree;
        }
      }

      // Check if there's a pending task description for this session's parent
      const parentId = await getParentId(client, sessionId);
      if (parentId) {
        // Check if this is a first-level child (parent is main session)
        const grandparentId = await getParentId(client, parentId);
        if (!grandparentId) {
          // Parent is main session - track this child (unless already completed)
          const completed = completedFirstLevelChildren.get(parentId);
          if (completed?.has(sessionId)) {
            log.debug(
              LOG.HOOK,
              `Skipping tracking for completed first-level child`,
              {
                childSessionId: sessionId,
                mainSessionId: parentId,
                alias: getAlias(sessionId),
              },
            );
          } else {
            let children = mainSessionActiveChildren.get(parentId);
            if (!children) {
              children = new Set();
              mainSessionActiveChildren.set(parentId, children);
            }
            children.add(sessionId);

            log.info(LOG.HOOK, `Tracking first-level child for main session`, {
              childSessionId: sessionId,
              mainSessionId: parentId,
              alias: getAlias(sessionId),
              activeChildrenCount: children.size,
            });
          }
        }

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

      // Inject Pocket Universe instructions (dynamically generated based on config)
      output.system.push(getSystemPrompt());

      // Inject agent's own worktree path if worktree feature is enabled
      if (isWorktreeEnabled()) {
        const worktreePath = getWorktree(sessionId);
        if (worktreePath) {
          output.system.push(getWorktreeSystemPrompt(worktreePath));
        }
      }

      log.info(
        LOG.INJECT,
        `Registered session and injected Pocket Universe system prompt`,
        {
          sessionId,
          alias: getAlias(sessionId),
          worktree: isWorktreeEnabled()
            ? getWorktree(sessionId) || "none"
            : "disabled",
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

      // Check for pending subagent outputs (user message mode - config false)
      // These need to be injected immediately, not at session.before_complete
      const pendingOutput = pendingSubagentOutputs.get(sessionId);
      if (pendingOutput) {
        // Remove from map before injecting to prevent double-injection
        pendingSubagentOutputs.delete(sessionId);

        log.info(
          LOG.INJECT,
          `Injecting pending subagent output into last user message`,
          {
            sessionId,
            senderAlias: pendingOutput.senderAlias,
            outputLength: pendingOutput.output.length,
          },
        );

        const now = Date.now();
        const pendingPart = {
          id: `prt_sub_out_${now}`,
          sessionID: sessionId,
          messageID: lastUserMsg.info.id,
          type: "text" as const,
          text: pendingOutput.output,
          synthetic: true,
        };

        lastUserMsg.parts.push(pendingPart);

        log.info(
          LOG.INJECT,
          `Injected subagent output into last user message`,
          {
            sessionId,
            senderAlias: pendingOutput.senderAlias,
          },
        );
      }

      // Check for pending subagents that need to be injected into this session
      const subagents = pendingSubagents.get(sessionId) || [];
      const uninjectedSubagents = subagents.filter((s) => !s.injected);

      if (uninjectedSubagents.length > 0) {
        log.info(
          LOG.INJECT,
          `Injecting ${uninjectedSubagents.length} synthetic task(s) for subagents`,
          {
            sessionId,
            subagents: uninjectedSubagents.map((s) => s.alias),
          },
        );

        // Inject synthetic task tool results for each subagent
        for (const subagent of uninjectedSubagents) {
          const taskMsg = createSubagentTaskMessage(
            sessionId,
            subagent,
            lastUserMsg,
          );
          output.messages.push(taskMsg as unknown as UserMessage);
          subagent.injected = true;

          log.info(LOG.INJECT, `Injected synthetic task for subagent`, {
            sessionId,
            subagentAlias: subagent.alias,
            subagentSessionId: subagent.sessionId,
          });
        }
      }

      // Only inject Pocket Universe broadcast/inbox for child sessions (those with parentID)
      if (!(await isChildSession(client, sessionId))) {
        // Main sessions receive a persisted SYNTHETIC Pocket Universe Summary when all work completes
        // (injected via injectPocketUniverseSummaryToMain in session.before_complete)
        //
        // We ALSO inject an ephemeral synthetic tool call here as a "cover" message.
        // This is kept for compatibility with some providers that have issues with
        // consecutive user messages or need a tool result before the next user message.
        // The cover message is ephemeral (not persisted) but provides visual feedback
        // and ensures proper message ordering for all providers.
        if (summaryInjectedSessions.has(sessionId)) {
          const coverMsg = createSummaryCoverMessage(
            sessionId,
            output.messages,
          );
          if (coverMsg) {
            output.messages.push(coverMsg as unknown as UserMessage);
            log.info(
              LOG.INJECT,
              `Injected cover tool for main session summary`,
              {
                sessionId,
              },
            );
          }
        }

        log.debug(
          LOG.INJECT,
          `Skipping Pocket Universe inbox for main session`,
          {
            sessionId,
            injectedSubagents: uninjectedSubagents.length,
          },
        );
        return;
      }

      // Register the session early so the agent knows its alias from the start
      // This must happen before we call getAlias() or inject any broadcasts
      registerSession(sessionId);

      const unhandled = getUnhandledMessages(sessionId);
      const parallelAgents = getParallelAgents(sessionId);

      log.debug(LOG.INJECT, `Checking for messages in transform`, {
        sessionId,
        unhandledCount: unhandled.length,
        parallelAgentCount: parallelAgents.length,
      });

      // Always inject inbox for child sessions - even if empty, agent needs to know its alias
      // via the you_are field in the inbox message

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
      const selfAlias = getAlias(sessionId);
      const inboxMsg = createInboxMessage(
        sessionId,
        unhandled,
        lastUserMsg,
        parallelAgents,
        hasAnnounced,
        selfAlias,
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

    // Add broadcast, recall, and subagent to subagent_tools (based on config)
    "experimental.config.transform": async (
      _input: unknown,
      output: ConfigTransformOutput,
    ) => {
      const experimental = output.experimental ?? {};
      const existingSubagentTools = experimental.subagent_tools ?? [];
      const toolsToAdd = [
        "broadcast",
        ...(isRecallEnabled() ? ["recall"] : []),
        ...(isSubagentEnabled() ? ["subagent"] : []),
      ];
      output.experimental = {
        ...experimental,
        subagent_tools: [...existingSubagentTools, ...toolsToAdd],
      };
      log.info(LOG.HOOK, `Added tools to experimental.subagent_tools`, {
        tools: toolsToAdd,
      });
    },
  };
};

export default plugin;
