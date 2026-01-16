// =============================================================================
// Subagent tool definition
// =============================================================================

import { tool } from '@opencode-ai/plugin';
import {
  SUBAGENT_DESCRIPTION,
  SUBAGENT_NOT_CHILD_SESSION,
  SUBAGENT_MISSING_PROMPT,
  subagentResult,
  SUBAGENT_CREATE_FAILED,
  subagentMaxDepth,
  receivedSubagentOutput,
  subagentError,
} from '../prompts/subagent.prompts';
import { log, LOG } from '../logger';
import type { OpenCodeSessionClient, ToolContext, SubagentInfo } from '../types';
import {
  sessionToAlias,
  sessionStates,
  activeSubagents,
  callerPendingSubagents,
  getAlias,
  registerSession,
  setWorktree,
  getWorktree,
  saveAgentToHistory,
  getVirtualDepth,
  setVirtualDepth,
} from '../state';
import {
  sendMessage,
  resumeSessionWithBroadcast,
  resumeWithSubagentOutput,
  getMessagesNeedingResume,
  markMessagesAsPresented,
} from '../messaging';
import {
  getParentId,
  injectTaskPartToParent,
  fetchSubagentOutput,
  markSubagentCompleted,
} from '../injection/index';
import { createAgentWorktree } from '../worktree';
import { getMaxSubagentDepth, isWorktreeEnabled, isSubagentResultForcedAttention } from '../config';

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
      if (msg.info.role === 'assistant') {
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
// Subagent Tool
// ============================================================================

export function createSubagentTool(client: OpenCodeSessionClient) {
  return tool({
    description: SUBAGENT_DESCRIPTION,
    args: {
      prompt: tool.schema.string().describe('The task for the new agent to perform'),
      description: tool.schema
        .string()
        .optional()
        .describe('Short description of the task (3-5 words)'),
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

      // Use virtual depth for spawn chain tracking (not actual session hierarchy)
      const callerDepth = getVirtualDepth(sessionId);
      const maxDepth = getMaxSubagentDepth();
      if (callerDepth >= maxDepth) {
        log.warn(LOG.TOOL, `subagent max depth reached`, {
          sessionId,
          callerDepth,
          maxDepth,
        });
        return subagentMaxDepth(callerDepth, maxDepth);
      }

      const callerAlias = getAlias(sessionId);
      const description = args.description || args.prompt.substring(0, 50);

      log.info(LOG.TOOL, `subagent called`, {
        callerAlias,
        callerDepth,
        descriptionLength: description.length,
        promptLength: args.prompt.length,
      });

      try {
        // Create a sibling session (child of same parent, not nested)
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

        // Set virtual depth for the new subagent (caller's depth + 1)
        const newDepth = callerDepth + 1;
        setVirtualDepth(newSessionId, newDepth);

        // Create isolated worktree for this agent (if enabled and in a git repo)
        if (isWorktreeEnabled()) {
          const worktreePath = await createAgentWorktree(newAlias, process.cwd());
          if (worktreePath) {
            setWorktree(newSessionId, worktreePath);
          }
        }

        log.info(LOG.TOOL, `subagent created session`, {
          callerAlias,
          newAlias,
          newSessionId,
          parentId,
          newDepth,
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
        const injected = await injectTaskPartToParent(client, parentId, subagentInfo);

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
              parts: [{ type: 'text', text: args.prompt }],
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
            const subagentOutput = await fetchSubagentOutput(client, newSessionId, newAlias);

            // 2. Mark session as idle IMMEDIATELY after capturing output (before any delivery)
            sessionStates.set(newSessionId, {
              sessionId: newSessionId,
              alias: newAlias,
              status: 'idle',
              lastActivity: Date.now(),
            });
            log.info(LOG.SESSION, `Subagent session marked idle`, {
              newSessionId,
              newAlias,
            });

            // 3. Save to history for recall tool
            saveAgentToHistory(newAlias, subagentOutput);

            // 4. Mark the subagent as completed in the parent TUI
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
            const callerAliasForPipe = sessionToAlias.get(sessionId) || 'caller';

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
              if (callerState?.status === 'idle') {
                // Caller is idle - resume with the output via broadcast
                log.info(LOG.TOOL, `Piping subagent output to idle caller via broadcast resume`, {
                  callerSessionId: sessionId,
                  callerAlias: callerAliasForPipe,
                  subagentAlias: newAlias,
                });
                resumeSessionWithBroadcast(sessionId, newAlias, outputMessage).catch((e) =>
                  log.error(LOG.TOOL, `Failed to pipe subagent output to caller`, {
                    error: String(e),
                  }),
                );
              } else {
                // Caller is still active - add to inbox for next synthetic injection
                log.info(LOG.TOOL, `Piping subagent output to active caller via inbox`, {
                  callerSessionId: sessionId,
                  callerAlias: callerAliasForPipe,
                  subagentAlias: newAlias,
                });
                sendMessage(newAlias, sessionId, outputMessage);
              }
            } else {
              // User message mode: output injected as resumePrompt via session.before_complete
              // NOTE: This currently waits until caller finishes current work - see TODO
              log.info(LOG.TOOL, `Storing subagent output for user message injection`, {
                callerSessionId: sessionId,
                callerAlias: callerAliasForPipe,
                subagentAlias: newAlias,
              });
              resumeWithSubagentOutput(sessionId, newAlias, subagentOutput).catch((e) =>
                log.error(LOG.TOOL, `Failed to store subagent output for user message`, {
                  error: String(e),
                }),
              );
            }

            // 5. Check for unread messages and resume subagent session if needed
            const unreadMessages = getMessagesNeedingResume(newSessionId);
            if (unreadMessages.length > 0) {
              log.info(LOG.SESSION, `Subagent session has unread messages, resuming`, {
                newSessionId,
                newAlias,
                unreadCount: unreadMessages.length,
              });
              const firstUnread = unreadMessages[0];
              markMessagesAsPresented(newSessionId, [firstUnread.msgIndex]);
              resumeSessionWithBroadcast(newSessionId, firstUnread.from, firstUnread.body).catch(
                (e) =>
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
