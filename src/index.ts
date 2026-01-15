import type { Plugin } from "@opencode-ai/plugin";
import { getSystemPrompt } from "./prompt";
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
  pendingSpawns,
  activeSpawns,
  callerPendingSpawns,
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
  createSpawnTaskMessage,
  createWorktreeSummaryMessage,
  fetchSpawnOutput,
  markSpawnCompleted,
} from "./messaging";
import {
  injectPocketUniverseSummaryToMain,
  createSummaryCoverMessage,
} from "./injection";
import { createBroadcastTool, createSpawnTool } from "./tools";
import { createAgentWorktree } from "./worktree";
import { isSpawnEnabled, isWorktreeEnabled } from "./config";

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

        // Check if this is a first-level child returning to main session
        // If so, inject the Pocket Universe Summary to the main session
        const parentId = await getParentId(client, input.sessionID);
        if (parentId && !summaryInjectedSessions.has(parentId)) {
          // Check if parent is a main session (has no grandparent)
          const grandparentId = await getParentId(client, parentId);
          if (!grandparentId) {
            // Parent is main session - inject the summary
            log.info(
              LOG.SESSION,
              `First-level child completing, injecting Pocket Universe Summary to main`,
              {
                childSessionId: input.sessionID,
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
        }

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
          await fetchSpawnOutput(client, sessionID, spawn.alias);
          await markSpawnCompleted(client, spawn);
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
      broadcast: createBroadcastTool(client),
      // Only register spawn tool if enabled in config
      ...(isSpawnEnabled() ? { spawn: createSpawnTool(client) } : {}),
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
          output.system.push(`
<worktree>
Your isolated working directory: ${worktreePath}
ALL file operations (read, write, edit, bash) should use paths within this directory.
Do NOT modify files outside this worktree.
</worktree>
`);
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
        // Main sessions receive a persisted Pocket Universe Summary when all work completes
        // (injected via injectPocketUniverseSummaryToMain in session.before_complete)
        //
        // We inject a minimal synthetic tool call here to "cover" the persisted user message
        // This helps with some providers that have issues with consecutive user messages
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
