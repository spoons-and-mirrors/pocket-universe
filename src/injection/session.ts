// =============================================================================
// Session helpers for injection
// =============================================================================

import type { OpenCodeSessionClient } from "../types";
import { log, LOG } from "../logger";
import {
  sessionParentCache,
  childSessionCache,
  PARENT_CACHE_TTL_MS,
} from "../state";

// DORMANT: parent alias feature
export async function getParentId(
  client: OpenCodeSessionClient,
  sessionId: string,
): Promise<string | null> {
  const now = Date.now();

  const cached = sessionParentCache.get(sessionId);
  if (cached && now - cached.cachedAt < PARENT_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const response = await client.session.get({ path: { id: sessionId } });
    const parentId = response.data?.parentID || null;
    sessionParentCache.set(sessionId, { value: parentId, cachedAt: now });
    log.debug(LOG.SESSION, `Looked up parentID`, { sessionId, parentId });
    return parentId;
  } catch (e) {
    log.warn(LOG.SESSION, `Failed to get session info`, {
      sessionId,
      error: String(e),
    });
    sessionParentCache.set(sessionId, {
      value: null,
      cachedAt: now - PARENT_CACHE_TTL_MS + 60000,
    });
    return null;
  }
}

/**
 * Check if a session is a child session (has parentID).
 * Uses cache for fast repeated checks.
 */
export async function isChildSession(
  client: OpenCodeSessionClient,
  sessionId: string,
): Promise<boolean> {
  // Fast path: already confirmed as child session
  if (childSessionCache.has(sessionId)) {
    return true;
  }

  const parentId = await getParentId(client, sessionId);
  if (parentId) {
    childSessionCache.add(sessionId);
    return true;
  }
  return false;
}

/**
 * Get the depth of a session in the tree (main session = 1).
 */
export async function getSessionDepth(
  client: OpenCodeSessionClient,
  sessionId: string,
): Promise<number> {
  let depth = 1;
  let currentId: string | null = sessionId;

  while (currentId) {
    const parentId = await getParentId(client, currentId);
    if (!parentId) {
      break;
    }
    depth += 1;
    currentId = parentId;
  }

  return depth;
}

/**
 * Get the parent ID for a subagent session.
 * Subagent sessions are children of the main session (grandparent of caller).
 */
export async function getParentIdForSubagent(
  client: OpenCodeSessionClient,
  subagentSessionId: string,
): Promise<string | null> {
  try {
    const response = await client.session.get({
      path: { id: subagentSessionId },
    });
    return response.data?.parentID || null;
  } catch (e) {
    log.warn(LOG.SESSION, `Failed to get parent ID for subagent session`, {
      subagentSessionId,
      error: String(e),
    });
    return null;
  }
}
