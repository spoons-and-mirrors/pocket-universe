// =============================================================================
// State management for the Pocket Universe plugin
// All in-memory stores, constants, cleanup, and alias management
// =============================================================================

import type {
  Message,
  CachedParentId,
  SessionState,
  SpawnInfo,
  OpenCodeSessionClient,
} from "./types";
import { log, LOG } from "./logger";

// ============================================================================
// Constants
// ============================================================================

export const CHAR_CODE_A = 65; // ASCII code for 'A'
export const ALPHABET_SIZE = 26;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MESSAGE_TTL_MS = 30 * 60 * 1000; // 30 minutes for handled messages
export const UNHANDLED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for unhandled messages
export const MAX_INBOX_SIZE = 100; // Max messages per inbox
export const PARENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute
export const DEFAULT_MODEL_ID = "gpt-4o-2024-08-06";
export const DEFAULT_PROVIDER_ID = "openai";
export const MAX_MESSAGE_LENGTH = 10000; // Prevent excessively long messages

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

// Alias mappings: sessionId <-> alias (e.g., "agentA", "agentB")
export const sessionToAlias = new Map<string, string>();
export const aliasToSession = new Map<string, string>();
export const agentDescriptions = new Map<string, string>(); // alias -> description

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

// Maps parentSessionId -> array of spawn info
export const pendingSpawns = new Map<string, SpawnInfo[]>();

// Track active spawns by sessionId for completion updates
export const activeSpawns = new Map<string, SpawnInfo>();

// Track pending spawns per CALLER session (not parent)
// When agentA spawns agentB, we track that agentA has a pending spawn
// Key: caller session ID, Value: Set of spawned session IDs
export const callerPendingSpawns = new Map<string, Set<string>>();

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
  agentDescriptions.set(alias, truncated);
  log.info(LOG.SESSION, `Agent announced`, { alias, description: truncated });
}

export function getDescription(alias: string): string | undefined {
  return agentDescriptions.get(alias);
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
