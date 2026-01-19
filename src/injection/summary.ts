// =============================================================================
// Summary helpers for injection
// =============================================================================

import type { UserMessage, AssistantMessage } from '../types';
import {
  POCKET_UNIVERSE_SUMMARY_HEADER,
  POCKET_UNIVERSE_AGENTS_INTRO,
  WORKTREE_MERGE_NOTE,
  WORKTREE_SUMMARY_HEADER,
  WORKTREE_SUMMARY_NOTE,
} from '../prompts/injection';
import { log, LOG } from '../logger';
import {
  sessionWorktrees,
  sessionToAlias,
  agentDescriptions,
  getStoredClient,
  cleanupCompletedAgents,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  sessionToRootId,
} from '../state';
import { isWorktreeEnabled } from '../config';

/**
 * Create a synthetic tool message containing the Pocket Universe Summary.
 * This is the full summary of all agents and their work, shown to the LLM
 * but not visible to the user in the TUI.
 */
export function createSummaryCoverMessage(
  sessionId: string,
  messages: Array<{
    info?: {
      id?: string;
      model?: { modelID?: string; providerID?: string };
      agent?: string;
    };
  }>,
): AssistantMessage | null {
  // Generate the full summary - pass sessionId as mainSessionId to filter agents
  // When this is called, sessionId is the main session (we only call this for main sessions)
  const summary = generatePocketUniverseSummary(sessionId);
  if (!summary) {
    return null;
  }

  // Find the last user message to extract info
  const lastUserMsg = [...messages]
    .reverse()
    .find((m) => (m as { info?: { role?: string } }).info?.role === 'user') as
    | {
        info: {
          id: string;
          model?: { modelID?: string; providerID?: string };
          agent?: string;
        };
      }
    | undefined;

  if (!lastUserMsg?.info) {
    return null;
  }

  const now = Date.now();
  const syntheticId = `pu-sum-${now}`; // Keep short to avoid exceeding 40 char limit

  return {
    info: {
      id: syntheticId,
      sessionID: sessionId,
      role: 'assistant',
      agent: lastUserMsg.info.agent || 'code',
      parentID: lastUserMsg.info.id,
      modelID: lastUserMsg.info.model?.modelID || DEFAULT_MODEL_ID,
      providerID: lastUserMsg.info.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: 'default',
      path: { cwd: '/', root: '/' },
      time: { created: now, completed: now },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `${syntheticId}-p`,
        sessionID: sessionId,
        messageID: syntheticId,
        type: 'tool',
        callID: `${syntheticId}-c`,
        tool: 'pocket_universe',
        state: {
          status: 'completed',
          input: { synthetic: true },
          output: summary,
          title: 'Pocket Universe Summary',
          metadata: {},
          time: { start: now, end: now },
        },
      },
    ],
  };
}

/**
 * Create a synthetic worktree summary for the main session.
 * Shows all active agent worktrees so main session knows where changes are.
 * Returns null if worktree feature is disabled.
 * @param sessionId - The session ID to create the summary for
 * @param baseUserMessage - The user message to base the synthetic message on
 * @param mainSessionId - The main session ID to filter worktrees by (only include from this pocket)
 */
export function createWorktreeSummaryMessage(
  sessionId: string,
  baseUserMessage: UserMessage,
  mainSessionId?: string,
): AssistantMessage | null {
  // Return null if worktree feature is disabled
  if (!isWorktreeEnabled()) {
    return null;
  }

  // Collect all active worktrees with their agent info
  const worktreeInfo: Array<{
    alias: string;
    description: string[] | undefined;
    worktree: string;
  }> = [];

  for (const [sessId, worktreePath] of sessionWorktrees.entries()) {
    // Filter by main session - only include worktrees from this main session
    // Main sessions are completely isolated - agents NEVER cross main sessions
    if (mainSessionId) {
      const agentRootId = sessionToRootId.get(sessId);
      if (agentRootId !== mainSessionId) {
        continue; // Different main session (or untracked), skip
      }
    }

    const alias = sessionToAlias.get(sessId);
    if (alias && worktreePath) {
      worktreeInfo.push({
        alias,
        description: agentDescriptions.get(alias), // Now an array
        worktree: worktreePath,
      });
    }
  }

  // Don't inject if no worktrees
  if (worktreeInfo.length === 0) {
    return null;
  }

  const now = Date.now();
  const userInfo = baseUserMessage.info;

  const assistantMessageId = `msg_worktrees_${now}`;
  const partId = `prt_worktrees_${now}`;
  const callId = `call_worktrees_${now}`;

  // Build structured output
  const outputData = {
    summary: WORKTREE_SUMMARY_HEADER,
    worktrees: worktreeInfo.map((w) => ({
      agent: w.alias,
      task: w.description || 'unknown',
      path: w.worktree,
    })),
    note: WORKTREE_SUMMARY_NOTE,
  };

  const output = JSON.stringify(outputData, null, 2);

  log.info(LOG.MESSAGE, `Creating worktree summary for main session`, {
    sessionId,
    worktreeCount: worktreeInfo.length,
    agents: worktreeInfo.map((w) => w.alias),
  });

  const result: AssistantMessage = {
    info: {
      id: assistantMessageId,
      sessionID: sessionId,
      role: 'assistant',
      agent: userInfo.agent || 'code',
      parentID: userInfo.id,
      modelID: userInfo.model?.modelID || DEFAULT_MODEL_ID,
      providerID: userInfo.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: 'default',
      path: { cwd: '/', root: '/' },
      time: { created: now, completed: now },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: partId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: 'tool',
        callID: callId,
        tool: 'pocket_universe_worktrees',
        state: {
          status: 'completed',
          input: { synthetic: true },
          output,
          title: `${worktreeInfo.length} agent worktree(s)`,
          metadata: {
            worktree_count: worktreeInfo.length,
            agents: worktreeInfo.map((w) => w.alias),
          },
          time: { start: now, end: now },
        },
      },
    ],
  };

  if (userInfo.variant !== undefined) {
    result.info.variant = userInfo.variant;
  }

  return result;
}

// =============================================================================
// Pocket Universe Summary (persisted to main session)
// =============================================================================

/**
 * Generate a Pocket Universe Summary for the main session.
 * This summarizes all agents, their status history, and worktree paths.
 * Called when all parallel work is complete, before returning to main session.
 * @param mainSessionId - The main session ID to filter agents by (only include agents from this pocket)
 */
export function generatePocketUniverseSummary(mainSessionId?: string): string | null {
  // Collect all agents from sessionToAlias
  // Note: Only child sessions (subagents) have aliases, so all entries are agents
  const agents: Array<{
    alias: string;
    statuses: string[];
    worktree: string | undefined;
  }> = [];

  for (const [sessionId, alias] of sessionToAlias.entries()) {
    // Filter by main session - only include agents from this main session
    // Main sessions are completely isolated - agents NEVER cross main sessions
    if (mainSessionId) {
      const agentRootId = sessionToRootId.get(sessionId);
      if (agentRootId !== mainSessionId) {
        continue; // Different main session (or untracked), skip
      }
    }

    const statuses = agentDescriptions.get(alias) || [];
    const worktree = isWorktreeEnabled() ? sessionWorktrees.get(sessionId) : undefined;

    agents.push({ alias, statuses, worktree });
  }

  // If no agents, no summary needed
  if (agents.length === 0) {
    return null;
  }

  // Build the summary
  const lines: string[] = [];
  lines.push(POCKET_UNIVERSE_SUMMARY_HEADER);
  lines.push('');
  lines.push(POCKET_UNIVERSE_AGENTS_INTRO);
  lines.push('');

  for (const agent of agents) {
    lines.push(`## ${agent.alias}`);
    if (agent.worktree) {
      lines.push(`Worktree: ${agent.worktree}`);
    }
    if (agent.statuses.length > 0) {
      lines.push(`Status history:`);
      for (const status of agent.statuses) {
        lines.push(`  → ${status}`);
      }
    }
    lines.push('');
  }

  if (isWorktreeEnabled()) {
    lines.push(WORKTREE_MERGE_NOTE);
  }

  return lines.join('\n');
}

/**
 * Inject the Pocket Universe Summary as a persisted SYNTHETIC user message into the main session.
 * Uses noReply: true to prevent AI loop, and synthetic: true to hide from TUI.
 * The message is persisted to the database but not visible to the user.
 */
export async function injectPocketUniverseSummaryToMain(mainSessionId: string): Promise<boolean> {
  const storedClient = getStoredClient();
  if (!storedClient) {
    log.warn(LOG.SESSION, `Cannot inject summary - no client available`);
    return false;
  }

  // Pass mainSessionId to filter agents to only those from this pocket universe
  const summary = generatePocketUniverseSummary(mainSessionId);
  if (!summary) {
    log.info(LOG.SESSION, `No agents to summarize, skipping pocket universe summary`);
    return false;
  }

  log.info(LOG.SESSION, `Injecting Pocket Universe Summary to main session`, {
    mainSessionId,
    summaryLength: summary.length,
  });

  try {
    // Inject as a persisted SYNTHETIC user message
    // - noReply: true prevents the AI loop from starting
    // - synthetic: true on the text part hides it from TUI
    // Note: SDK types are incomplete, so we cast the body
    await storedClient.session.prompt({
      path: { id: mainSessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: summary, synthetic: true }],
      } as unknown as { parts: Array<{ type: string; text: string }> },
    });

    log.info(LOG.SESSION, `Pocket Universe Summary injected successfully`, {
      mainSessionId,
    });

    // Clean up completed agents so they don't appear in getParallelAgents()
    // for subsequent tasks in the main session
    cleanupCompletedAgents();

    return true;
  } catch (e) {
    log.error(LOG.SESSION, `Failed to inject Pocket Universe Summary`, {
      mainSessionId,
      error: String(e),
    });
    return false;
  }
}
