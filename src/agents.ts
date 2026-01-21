// =============================================================================
// Agent list helpers
// =============================================================================

import type { AgentInfo, InternalClient, OpenCodeSessionClient } from './types';
import { log, LOG } from './logger';

const AGENT_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedAgents: AgentInfo[] = [];
let cachedAt = 0;
let inFlight: Promise<AgentInfo[]> | null = null;

function getInternalClient(client: OpenCodeSessionClient): InternalClient | undefined {
  const direct = (client as unknown as { client?: InternalClient }).client;
  if (direct?.get) {
    return direct;
  }
  const alt = (client as unknown as { _client?: InternalClient })._client;
  if (alt?.get) {
    return alt;
  }
  return direct || alt;
}

function normalizeAgents(data: unknown): AgentInfo[] | null {
  if (!Array.isArray(data)) {
    return null;
  }

  return data
    .filter((agent): agent is AgentInfo =>
      Boolean(agent && typeof (agent as AgentInfo).name === 'string')
    )
    .map((agent) => agent as AgentInfo);
}

function filterSubagentAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.mode !== 'primary' && !agent.hidden);
}

export async function listSubagentAgents(client: OpenCodeSessionClient): Promise<AgentInfo[]> {
  const now = Date.now();
  if (cachedAgents.length > 0 && now - cachedAt < AGENT_CACHE_TTL_MS) {
    return cachedAgents;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const internalClient = getInternalClient(client);
    if (!internalClient?.get) {
      log.warn(LOG.TOOL, 'No internal client available for /agent list');
      return cachedAgents;
    }

    try {
      const response = await internalClient.get({
        url: '/agent',
      });
      const data = (response as { data?: unknown }).data ?? response;
      const normalized = normalizeAgents(data);

      if (!normalized) {
        log.warn(LOG.TOOL, 'Unexpected /agent response format');
        return cachedAgents;
      }

      const filtered = filterSubagentAgents(normalized);
      cachedAgents = filtered;
      cachedAt = Date.now();
      return filtered;
    } catch (error) {
      log.warn(LOG.TOOL, 'Failed to fetch /agent list', {
        error: String(error),
      });
      return cachedAgents;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
