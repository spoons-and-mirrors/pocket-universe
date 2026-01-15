// =============================================================================
// State management for the Pocket Universe plugin
// All in-memory stores, constants, cleanup, and alias management
// =============================================================================

import type {
  Message,
  CachedParentId,
  SessionState,
  SubagentInfo,
  OpenCodeSessionClient,
} from "./types";
import { log, LOG } from "./logger";
import { RECALL_AGENT_ACTIVE, RECALL_AGENT_IDLE_NO_OUTPUT } from "./prompt";

// ============================================================================
// Constants
// ============================================================================

export const CHAR_CODE_A = 65; // ASCII code for 'A'
export const ALPHABET_SIZE = 26;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MAX_STATUS_HISTORY = 50; // Keep last N status updates per agent
export const MESSAGE_TTL_MS = 30 * 60 * 1000; // 30 minutes for handled messages
export const UNHANDLED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for unhandled messages
export const MAX_INBOX_SIZE = 100; // Max messages per inbox
export const PARENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute
export const DEFAULT_MODEL_ID = "gpt-4o-2024-08-06";
export const DEFAULT_PROVIDER_ID = "openai";
export const MAX_MESSAGE_LENGTH = 10000; // Prevent excessively long messages
export const WORKTREES_DIR = ".worktrees"; // Directory for agent worktrees

// ============================================================================
// Completed Agent History (persists across pocket universe cleanups)
// ============================================================================

export interface CompletedAgentRecord {
  alias: string;
  statusHistory: string[];
  finalOutput: string;
  state: "completed";
  completedAt: number;
}

// History of completed agents - survives cleanup within same opencode session
// This allows agents in new pocket universes to recall what previous agents did
export const completedAgentHistory: CompletedAgentRecord[] = [];

// Store final outputs for agents as they complete (used before saving to history)
export const agentFinalOutputs = new Map<string, string>(); // alias -> output

/**
 * Save an agent's data to the completed history.
 * Called when an agent completes its work.
 */
export function saveAgentToHistory(alias: string, finalOutput: string): void {
  const statusHistory = agentDescriptions.get(alias) || [];

  // Check if already in history (avoid duplicates)
  const existing = completedAgentHistory.find((r) => r.alias === alias);
  if (existing) {
    log.debug(LOG.SESSION, `Agent already in history, updating`, { alias });
    existing.statusHistory = [...statusHistory];
    existing.finalOutput = finalOutput;
    existing.completedAt = Date.now();
    return;
  }

  const record: CompletedAgentRecord = {
    alias,
    statusHistory: [...statusHistory],
    finalOutput,
    state: "completed",
    completedAt: Date.now(),
  };

  completedAgentHistory.push(record);
  log.info(LOG.SESSION, `Saved agent to history`, {
    alias,
    statusCount: statusHistory.length,
    outputLength: finalOutput.length,
    totalHistory: completedAgentHistory.length,
  });
}

/**
 * Get agent info for recall tool - queries both active agents and history.
 * Output is only included when showOutput=true AND agentName is specified.
 */
export function recallAgents(
  agentName?: string,
  showOutput?: boolean,
): {
  agents: Array<{
    name: string;
    status_history: string[];
    state: "active" | "idle" | "completed";
    output?: string;
  }>;
} {
  const results: Array<{
    name: string;
    status_history: string[];
    state: "active" | "idle" | "completed";
    output?: string;
  }> = [];

  // Only include output if BOTH agent_name is specified AND show_output is true
  const includeOutput = Boolean(agentName && showOutput);

  // First, add historical (completed) agents
  for (const record of completedAgentHistory) {
    if (agentName && record.alias !== agentName) continue;
    const entry: {
      name: string;
      status_history: string[];
      state: "active" | "idle" | "completed";
      output?: string;
    } = {
      name: record.alias,
      status_history: record.statusHistory,
      state: "completed",
    };
    if (includeOutput) {
      entry.output = record.finalOutput;
    }
    results.push(entry);
  }

  // Then add active agents (not yet in history)
  for (const [alias, sessionId] of aliasToSession) {
    // Skip if already in history
    if (completedAgentHistory.some((r) => r.alias === alias)) continue;
    if (agentName && alias !== agentName) continue;

    const statusHistory = agentDescriptions.get(alias) || [];
    const sessionState = sessionStates.get(sessionId);
    const state = sessionState?.status === "idle" ? "idle" : "active";

    const entry: {
      name: string;
      status_history: string[];
      state: "active" | "idle" | "completed";
      output?: string;
    } = {
      name: alias,
      status_history: statusHistory,
      state,
    };
    if (includeOutput) {
      const storedOutput = agentFinalOutputs.get(alias);
      if (storedOutput) {
        entry.output = storedOutput;
      } else if (state === "active") {
        entry.output = RECALL_AGENT_ACTIVE;
      } else {
        entry.output = RECALL_AGENT_IDLE_NO_OUTPUT;
      }
    }
    results.push(entry);
  }

  return { agents: results };
}

// ============================================================================
// In-memory message store
// ============================================================================

// Inboxes indexed by recipient session ID
export const inboxes = new Map<string, Message[]>();

// Message index counter per session (for numeric IDs)
export const sessionMsgCounter = new Map<string, number>();

// Track ALL active sessions
export const activeSessions = new Set<string>();

// Track sessions that have announced themselves (called broadcast at least once)
export const announcedSessions = new Set<string>();

// Track sessions that have had pocket universe summary injected (prevent double injection)
export const summaryInjectedSessions = new Set<string>();

// Alias mappings: sessionId <-> alias (e.g., "agentA", "agentB")
export const sessionToAlias = new Map<string, string>();
export const aliasToSession = new Map<string, string>();
export const agentDescriptions = new Map<string, string[]>(); // alias -> status history (most recent last)

// Atomic alias counter with registration lock
let nextAgentIndex = 0;
const registeringSessionsLock = new Set<string>(); // Prevent race conditions

// DORMANT: parent alias feature
// Cache for parentID lookups with expiry
export const sessionParentCache = new Map<string, CachedParentId>();

// Cache for child session checks (fast path)
export const childSessionCache = new Set<string>();

// Store pending task descriptions by parent session ID
// parentSessionId -> array of descriptions (most recent last)
export const pendingTaskDescriptions = new Map<string, string[]>();

// Track messages that were presented to an agent via transform injection
// Key: sessionId, Value: Set of msgIndex that were presented
export const presentedMessages = new Map<string, Set<number>>();

// Maps parentSessionId -> array of subagent info
export const pendingSubagents = new Map<string, SubagentInfo[]>();

// Track active subagents by sessionId for completion updates
export const activeSubagents = new Map<string, SubagentInfo>();

// Track pending subagents per CALLER session (not parent)
// When agentA spawns agentB, we track that agentA has a pending subagent
// Key: caller session ID, Value: Set of spawned session IDs
export const callerPendingSubagents = new Map<string, Set<string>>();

// Track active first-level children per MAIN session
// This prevents premature summary injection when main session spawns multiple task tools in parallel
// Key: main session ID, Value: Set of active child session IDs
export const mainSessionActiveChildren = new Map<string, Set<string>>();

// Track completed first-level children to prevent re-adding them after completion
// Key: main session ID, Value: Set of completed child session IDs
export const completedFirstLevelChildren = new Map<string, Set<string>>();

// Track sessions that have been cleaned up to prevent re-registration
// After cleanup, hooks may still fire for these sessions - we must ignore them
export const cleanedUpSessions = new Set<string>();

// Pending subagent outputs for the "no forced attention" code path
// When subagent completes and we want to inject as user message, we store here
// session.before_complete picks this up and sets resumePrompt
// Key: recipient session ID, Value: { senderAlias, output }
export const pendingSubagentOutputs = new Map<
  string,
  { senderAlias: string; output: string }
>();

// ============================================================================
// Worktree Tracking (isolated working directories per agent)
// ============================================================================

// Map sessionId -> absolute worktree path
export const sessionWorktrees = new Map<string, string>();

export function getWorktree(sessionId: string): string | undefined {
  return sessionWorktrees.get(sessionId);
}

export function setWorktree(sessionId: string, worktreePath: string): void {
  sessionWorktrees.set(sessionId, worktreePath);
  log.info(LOG.SESSION, `Worktree assigned`, { sessionId, worktreePath });
}

export function removeWorktree(sessionId: string): void {
  sessionWorktrees.delete(sessionId);
}

// ============================================================================
// Session State Tracking (for broadcast resumption)
// ============================================================================

// Track session states for resumption
export const sessionStates = new Map<string, SessionState>();

// Store the client reference for resumption calls
let storedClient: OpenCodeSessionClient | null = null;

export function getStoredClient(): OpenCodeSessionClient | null {
  return storedClient;
}

export function setStoredClient(client: OpenCodeSessionClient): void {
  storedClient = client;
}

// ============================================================================
// Cleanup - prevent memory leaks
// ============================================================================

function cleanupExpiredMessages(): void {
  const now = Date.now();
  let totalRemoved = 0;

  for (const [sessionId, messages] of inboxes) {
    const before = messages.length;

    // Remove expired messages based on handled status
    const filtered = messages.filter((m: Message) => {
      if (m.handled) {
        return now - m.timestamp < MESSAGE_TTL_MS;
      }
      // Keep unhandled messages much longer
      return now - m.timestamp < UNHANDLED_TTL_MS;
    });

    // Trim to max size if needed
    if (filtered.length > MAX_INBOX_SIZE) {
      const unhandled = filtered.filter((m: Message) => !m.handled);
      const handled = filtered.filter((m: Message) => m.handled);
      handled.sort((a: Message, b: Message) => b.timestamp - a.timestamp);

      if (unhandled.length > MAX_INBOX_SIZE) {
        unhandled.sort((a: Message, b: Message) => b.timestamp - a.timestamp);
        inboxes.set(sessionId, unhandled.slice(0, MAX_INBOX_SIZE));
        totalRemoved += before - MAX_INBOX_SIZE;
      } else {
        const kept = [
          ...unhandled,
          ...handled.slice(0, MAX_INBOX_SIZE - unhandled.length),
        ];
        inboxes.set(sessionId, kept);
        totalRemoved += before - kept.length;
      }
    } else {
      inboxes.set(sessionId, filtered);
      totalRemoved += before - filtered.length;
    }

    // Remove empty queues
    if (inboxes.get(sessionId)!.length === 0) {
      inboxes.delete(sessionId);
    }
  }

  // DORMANT: parent alias feature
  // Cleanup expired parent cache entries
  for (const [sessionId, cached] of sessionParentCache) {
    if (now - cached.cachedAt > PARENT_CACHE_TTL_MS) {
      sessionParentCache.delete(sessionId);
    }
  }

  if (totalRemoved > 0) {
    log.debug(LOG.MESSAGE, `Cleanup removed ${totalRemoved} expired messages`);
  }
}

// Start cleanup interval
setInterval(cleanupExpiredMessages, CLEANUP_INTERVAL_MS);

// ============================================================================
// Alias management
// ============================================================================

export function getNextAlias(): string {
  const index = nextAgentIndex;
  nextAgentIndex++;

  const letter = String.fromCharCode(CHAR_CODE_A + (index % ALPHABET_SIZE));
  const suffix =
    index >= ALPHABET_SIZE ? Math.floor(index / ALPHABET_SIZE).toString() : "";
  return `agent${letter}${suffix}`;
}

export function getAlias(sessionId: string): string {
  return sessionToAlias.get(sessionId) || sessionId;
}

export function setDescription(sessionId: string, description: string): void {
  const alias = getAlias(sessionId);
  const truncated = description.substring(0, MAX_DESCRIPTION_LENGTH);

  // Get or create status history array
  let history = agentDescriptions.get(alias);
  if (!history) {
    history = [];
    agentDescriptions.set(alias, history);
  }

  // Add new status to history
  history.push(truncated);

  // Trim to max history size
  if (history.length > MAX_STATUS_HISTORY) {
    history.shift(); // Remove oldest
  }

  log.info(LOG.SESSION, `Agent status updated`, {
    alias,
    status: truncated,
    historyLength: history.length,
  });
}

export function getDescription(alias: string): string[] | undefined {
  return agentDescriptions.get(alias);
}

export function getLatestStatus(alias: string): string | undefined {
  const history = agentDescriptions.get(alias);
  return history && history.length > 0
    ? history[history.length - 1]
    : undefined;
}

export function resolveAlias(
  aliasOrSessionId: string,
  // DORMANT: parent alias feature
  parentId?: string | null,
): string | undefined {
  // Handle special "parent" alias (DORMANT)
  if (aliasOrSessionId === "parent" && parentId) {
    return parentId;
  }
  // Try alias first, then assume it's a session ID
  return (
    aliasToSession.get(aliasOrSessionId) ||
    (activeSessions.has(aliasOrSessionId) ? aliasOrSessionId : undefined)
  );
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function getNextMsgIndex(sessionId: string): number {
  const current = sessionMsgCounter.get(sessionId) || 0;
  const next = current + 1;
  sessionMsgCounter.set(sessionId, next);
  return next;
}

export function getInbox(sessionId: string): Message[] {
  if (!inboxes.has(sessionId)) {
    inboxes.set(sessionId, []);
  }
  return inboxes.get(sessionId)!;
}

export function registerSession(sessionId: string): void {
  // Don't re-register sessions that have been cleaned up
  if (cleanedUpSessions.has(sessionId)) {
    log.debug(LOG.SESSION, `Skipping registration for cleaned up session`, {
      sessionId,
    });
    return;
  }

  if (activeSessions.has(sessionId)) {
    return;
  }

  if (registeringSessionsLock.has(sessionId)) {
    return;
  }

  registeringSessionsLock.add(sessionId);

  try {
    if (!activeSessions.has(sessionId)) {
      activeSessions.add(sessionId);
      const alias = getNextAlias();
      sessionToAlias.set(sessionId, alias);
      aliasToSession.set(alias, sessionId);
      log.info(LOG.SESSION, `Session registered`, {
        sessionId,
        alias,
        totalSessions: activeSessions.size,
      });
    }
  } finally {
    registeringSessionsLock.delete(sessionId);
  }
}

// ============================================================================
// Cleanup completed agents
// ============================================================================

/**
 * Clean up all completed agents after the Pocket Universe Summary is injected.
 * This prevents stale agents from appearing in getParallelAgents() for subsequent tasks.
 *
 * Called right after injectPocketUniverseSummaryToMain() succeeds.
 * Clears all agent-related state so the next task batch starts fresh.
 */
export function cleanupCompletedAgents(): void {
  // Collect stats for logging
  const stats = {
    sessions: activeSessions.size,
    aliases: sessionToAlias.size,
    descriptions: agentDescriptions.size,
    inboxes: inboxes.size,
    announced: announcedSessions.size,
    worktrees: sessionWorktrees.size,
    sessionStates: sessionStates.size,
    childCache: childSessionCache.size,
    presentedMsgs: presentedMessages.size,
    pendingSubagents: pendingSubagents.size,
    activeSubagents: activeSubagents.size,
    callerPendingSubagents: callerPendingSubagents.size,
    mainSessionActiveChildren: mainSessionActiveChildren.size,
    completedFirstLevelChildren: completedFirstLevelChildren.size,
    cleanedUpSessions: cleanedUpSessions.size,
  };

  // Mark all current sessions as cleaned up BEFORE clearing
  // This prevents them from being re-registered when post-cleanup hooks fire
  for (const sessionId of activeSessions) {
    cleanedUpSessions.add(sessionId);
  }

  // Clear all agent-related state
  activeSessions.clear();
  sessionToAlias.clear();
  aliasToSession.clear();
  agentDescriptions.clear();
  inboxes.clear();
  sessionMsgCounter.clear();
  announcedSessions.clear();
  sessionWorktrees.clear();
  sessionStates.clear();
  childSessionCache.clear();
  presentedMessages.clear();
  pendingSubagents.clear();
  activeSubagents.clear();
  callerPendingSubagents.clear();
  mainSessionActiveChildren.clear();
  completedFirstLevelChildren.clear();
  pendingSubagentOutputs.clear();
  // Note: We do NOT clear cleanedUpSessions here - it tracks sessions across cleanups
  pendingTaskDescriptions.clear();

  // Note: We do NOT clear summaryInjectedSessions here
  // because that's used to track which main sessions got summaries
  // (prevents double-injection for the same parent)

  // Note: We do NOT clear sessionParentCache - that's a cache optimization
  // and clearing it would just cause extra API calls

  // Note: We do NOT reset nextAgentIndex - aliases continue incrementing
  // across batches to avoid confusion (agentA in batch 1 vs agentA in batch 2)

  log.info(LOG.SESSION, `Cleaned up completed agents`, stats);
}
