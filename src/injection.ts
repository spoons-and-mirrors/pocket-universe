// =============================================================================
// Injection helpers for synthetic message creation and TUI updates
// =============================================================================

import type {
  Message,
  OpenCodeSessionClient,
  UserMessage,
  AssistantMessage,
  SpawnInfo,
  InternalClient,
} from "./types";
import type { ParallelAgent } from "./prompt";
import { log, LOG } from "./logger";
import {
  sessionParentCache,
  childSessionCache,
  activeSpawns,
  sessionWorktrees,
  sessionToAlias,
  agentDescriptions,
  PARENT_CACHE_TTL_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
} from "./state";
import { isWorktreeEnabled } from "./config";

// ============================================================================
// Session utils
// ============================================================================

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

// ============================================================================
// Helper to create bundled assistant message with inbox
// ============================================================================

export function createInboxMessage(
  sessionId: string,
  messages: Message[],
  baseUserMessage: UserMessage,
  parallelAgents: ParallelAgent[],
  hasAnnounced: boolean,
): AssistantMessage {
  const now = Date.now();
  const userInfo = baseUserMessage.info;

  // Build structured output - this is what the LLM sees as the "tool result"
  // Agents section shows available agents and their status (not replyable)
  // Messages section shows replyable messages
  const outputData: {
    hint?: string;
    agents?: Array<{ name: string; status?: string; worktree?: string }>;
    messages?: Array<{ id: number; from: string; content: string }>;
  } = {};

  // Add hint for unannounced agents
  if (!hasAnnounced) {
    outputData.hint =
      'ACTION REQUIRED: Announce yourself to other agents by calling broadcast(message="what you\'re working on")';
  }

  // Build agents section from parallelAgents (status comes from agentDescriptions)
  if (parallelAgents.length > 0) {
    outputData.agents = parallelAgents.map((agent) => ({
      name: agent.alias,
      status: agent.description,
      worktree: agent.worktree,
    }));
  }

  // All messages in inbox are regular messages (replyable)
  if (messages.length > 0) {
    outputData.messages = messages.map((m) => ({
      id: m.msgIndex,
      from: m.from,
      content: m.body,
    }));
  }

  const assistantMessageId = `msg_broadcast_${now}`;
  const partId = `prt_broadcast_${now}`;
  const callId = `call_broadcast_${now}`;

  // Build short title for UI display
  const titleParts: string[] = [];
  if (parallelAgents.length > 0) {
    titleParts.push(`${parallelAgents.length} agent(s)`);
  }
  if (messages.length > 0) {
    titleParts.push(`${messages.length} message(s)`);
  }
  const title = titleParts.length > 0 ? titleParts.join(", ") : "Inbox";

  // Output is the structured data the LLM sees
  const output = JSON.stringify(outputData);

  log.info(LOG.MESSAGE, `Creating inbox injection`, {
    sessionId,
    agents: parallelAgents.map((a) => a.alias),
    agentStatuses: parallelAgents.map((a) => a.description?.substring(0, 50)),
    messageIds: messages.map((m) => m.msgIndex),
    messageFroms: messages.map((m) => m.from),
  });

  const result: AssistantMessage = {
    info: {
      id: assistantMessageId,
      sessionID: sessionId,
      role: "assistant",
      agent: userInfo.agent || "code",
      parentID: userInfo.id,
      modelID: userInfo.model?.modelID || DEFAULT_MODEL_ID,
      providerID: userInfo.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: "default",
      path: { cwd: "/", root: "/" },
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
        type: "tool",
        callID: callId,
        tool: "broadcast",
        state: {
          status: "completed",
          input: { synthetic: true }, // Hints this was injected by Pocket Universe, not a real agent call
          output,
          title,
          metadata: {
            incoming_message: messages.length > 0,
            message_count: messages.length,
            agent_count: parallelAgents.length,
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

/**
 * Create a synthetic worktree summary for the main session.
 * Shows all active agent worktrees so main session knows where changes are.
 * Returns null if worktree feature is disabled.
 */
export function createWorktreeSummaryMessage(
  sessionId: string,
  baseUserMessage: UserMessage,
): AssistantMessage | null {
  // Return null if worktree feature is disabled
  if (!isWorktreeEnabled()) {
    return null;
  }

  // Collect all active worktrees with their agent info
  const worktreeInfo: Array<{
    alias: string;
    description: string | undefined;
    worktree: string;
  }> = [];

  for (const [sessId, worktreePath] of sessionWorktrees.entries()) {
    const alias = sessionToAlias.get(sessId);
    if (alias && worktreePath) {
      worktreeInfo.push({
        alias,
        description: agentDescriptions.get(alias),
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
    summary: "Active agent worktrees - each agent works in isolation",
    worktrees: worktreeInfo.map((w) => ({
      agent: w.alias,
      task: w.description || "unknown",
      path: w.worktree,
    })),
    note: "Changes made by agents are preserved in their worktrees. You may need to merge them.",
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
      role: "assistant",
      agent: userInfo.agent || "code",
      parentID: userInfo.id,
      modelID: userInfo.model?.modelID || DEFAULT_MODEL_ID,
      providerID: userInfo.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: "default",
      path: { cwd: "/", root: "/" },
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
        type: "tool",
        callID: callId,
        tool: "pocket_universe_worktrees",
        state: {
          status: "completed",
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

/**
 * Create a synthetic task tool message to inject into parent session
 * This makes spawned sessions appear as task tool calls in the parent's history
 */
export function createSpawnTaskMessage(
  parentSessionId: string,
  spawn: SpawnInfo,
  baseUserMessage: UserMessage,
): AssistantMessage {
  const now = Date.now();
  const userInfo = baseUserMessage.info;

  const assistantMessageId = `msg_spwn_${spawn.sessionId.slice(-12)}`;
  const partId = `prt_spwn_${spawn.sessionId.slice(-12)}`;
  const callId = `call_spwn_${spawn.sessionId.slice(-12)}`;

  // Build output similar to what task tool produces
  const output = `Spawned agent ${spawn.alias} is running.
Task: ${spawn.description}

<task_metadata>
session_id: ${spawn.sessionId}
</task_metadata>`;

  log.info(LOG.MESSAGE, `Creating synthetic task injection`, {
    parentSessionId,
    spawnAlias: spawn.alias,
    spawnSessionId: spawn.sessionId,
  });

  const result: AssistantMessage = {
    info: {
      id: assistantMessageId,
      sessionID: parentSessionId,
      role: "assistant",
      agent: userInfo.agent || "code",
      parentID: userInfo.id,
      modelID: userInfo.model?.modelID || DEFAULT_MODEL_ID,
      providerID: userInfo.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: "default",
      path: { cwd: "/", root: "/" },
      time: { created: spawn.timestamp, completed: now },
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
        sessionID: parentSessionId,
        messageID: assistantMessageId,
        type: "tool",
        callID: callId,
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: spawn.description,
            prompt: spawn.prompt,
            subagent_type: "general",
            synthetic: true, // Indicates this was spawned by Pocket Universe
          },
          output,
          title: spawn.description,
          metadata: {
            sessionId: spawn.sessionId,
            spawned_by_pocket_universe: true,
          },
          time: { start: spawn.timestamp, end: now },
        },
      },
    ],
  };

  if (userInfo.variant !== undefined) {
    result.info.variant = userInfo.variant;
  }

  return result;
}

/**
 * Inject a task tool part directly into the parent session's message history.
 * This makes the spawned task visible in the TUI immediately.
 * Uses the internal HTTP client (client.client) to PATCH the part.
 */
export async function injectTaskPartToParent(
  client: OpenCodeSessionClient,
  parentSessionId: string,
  spawn: SpawnInfo,
): Promise<boolean> {
  try {
    // Step 1: Get messages from parent session to find an existing assistant message
    const messagesResult = await client.session.messages({
      path: { id: parentSessionId },
    });

    const messages = messagesResult.data;
    if (!messages || messages.length === 0) {
      log.warn(LOG.TOOL, `No messages found in parent session`, {
        parentSessionId,
      });
      return false;
    }

    // Find the last assistant message to attach to
    const lastAssistantMsg = [...messages]
      .reverse()
      .find((m) => m.info.role === "assistant");

    if (!lastAssistantMsg) {
      log.warn(LOG.TOOL, `No assistant message found in parent session`, {
        parentSessionId,
      });
      return false;
    }

    const messageId = lastAssistantMsg.info.id;
    const now = Date.now();

    // Step 2: Create the task tool part (NOT synthetic - visible in TUI)
    const partId = `prt_spwn_${spawn.sessionId.slice(-12)}_${now}`;
    const callId = `call_spwn_${spawn.sessionId.slice(-12)}`;

    // Store part info in spawn for later completion update
    spawn.partId = partId;
    spawn.parentMessageId = messageId;
    spawn.parentSessionId = parentSessionId;

    const taskPart = {
      id: partId,
      sessionID: parentSessionId,
      messageID: messageId,
      type: "tool",
      callID: callId,
      tool: "task",
      state: {
        status: "running", // Show as running since it's executing in parallel
        input: {
          description: spawn.description,
          prompt: spawn.prompt,
          subagent_type: "general",
        },
        output: `Spawned agent ${spawn.alias} is running in parallel.\nSession: ${spawn.sessionId}`,
        title: spawn.description,
        metadata: {
          sessionId: spawn.sessionId,
          spawned_by_pocket_universe: true,
        },
        time: { start: spawn.timestamp, end: 0 }, // end=0 indicates still running
      },
    };

    log.info(LOG.TOOL, `Injecting task part to parent`, {
      parentSessionId,
      messageId,
      partId,
      spawnAlias: spawn.alias,
    });

    // Step 3: PATCH the part to the parent session using internal HTTP client
    const httpClient = (client as unknown as { client?: InternalClient })
      .client;
    if (!httpClient?.patch) {
      // Try alternative access pattern
      const altClient = (client as unknown as { _client?: InternalClient })
        ._client;
      if (altClient?.patch) {
        await (
          altClient as unknown as {
            patch: (params: { url: string; body: unknown }) => Promise<unknown>;
          }
        ).patch({
          url: `/session/${parentSessionId}/message/${messageId}/part/${partId}`,
          body: taskPart,
        });
        log.info(LOG.TOOL, `Task part injected via _client.patch`, {
          partId,
          spawnAlias: spawn.alias,
        });
        return true;
      }
      log.warn(LOG.TOOL, `No HTTP client available for PATCH`, {
        clientKeys: Object.keys(client),
      });
      return false;
    }

    await (
      httpClient as unknown as {
        patch: (params: { url: string; body: unknown }) => Promise<unknown>;
      }
    ).patch({
      url: `/session/${parentSessionId}/message/${messageId}/part/${partId}`,
      body: taskPart,
    });

    log.info(LOG.TOOL, `Task part injected successfully`, {
      partId,
      spawnAlias: spawn.alias,
    });
    return true;
  } catch (e) {
    log.error(LOG.TOOL, `Failed to inject task part`, {
      parentSessionId,
      spawnAlias: spawn.alias,
      error: String(e),
    });
    return false;
  }
}

/**
 * Get the parent ID for a spawned session.
 * Spawned sessions are children of the main session (grandparent of caller).
 */
export async function getParentIdForSpawn(
  client: OpenCodeSessionClient,
  spawnedSessionId: string,
): Promise<string | null> {
  try {
    const response = await client.session.get({
      path: { id: spawnedSessionId },
    });
    return response.data?.parentID || null;
  } catch (e) {
    log.warn(LOG.SESSION, `Failed to get parent ID for spawned session`, {
      spawnedSessionId,
      error: String(e),
    });
    return null;
  }
}

/**
 * Fetch the actual output from a spawned session.
 * Mimics how the native Task tool extracts the last text part.
 */
export async function fetchSpawnOutput(
  client: OpenCodeSessionClient,
  sessionId: string,
  alias: string,
): Promise<string> {
  try {
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
    });

    const messages = messagesResult.data;
    if (!messages || messages.length === 0) {
      log.warn(LOG.TOOL, `No messages found in spawned session`, {
        sessionId,
        alias,
      });
      return `Agent ${alias} completed.\nSession: ${sessionId}`;
    }

    // Find assistant messages and extract text parts (like native Task tool does)
    const assistantMessages = messages.filter(
      (m) => m.info.role === "assistant",
    );

    if (assistantMessages.length === 0) {
      log.warn(LOG.TOOL, `No assistant messages in spawned session`, {
        sessionId,
        alias,
      });
      return `Agent ${alias} completed.\nSession: ${sessionId}`;
    }

    // Get the last assistant message
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const parts = lastAssistant.parts || [];

    // Find the last text part (like native Task tool: result.parts.findLast(x => x.type === "text"))
    const textParts = parts.filter(
      (p: unknown) => (p as { type?: string }).type === "text",
    );
    const lastTextPart = textParts[textParts.length - 1] as
      | { text?: string }
      | undefined;
    const text = lastTextPart?.text || "";

    if (text) {
      log.info(LOG.TOOL, `Extracted output from spawned session`, {
        sessionId,
        alias,
        textLength: text.length,
      });
      // Format like native Task tool does
      return (
        text +
        "\n\n<task_metadata>\nsession_id: " +
        sessionId +
        "\n</task_metadata>"
      );
    }

    // Fallback: summarize tool calls if no text
    const toolParts = parts.filter(
      (p: unknown) => (p as { type?: string }).type === "tool",
    );
    if (toolParts.length > 0) {
      const summary = toolParts
        .map((p: unknown) => {
          const part = p as { tool?: string; state?: { title?: string } };
          return `- ${part.tool}: ${part.state?.title || "completed"}`;
        })
        .join("\n");
      return `Agent ${alias} completed:\n${summary}\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
    }

    return `Agent ${alias} completed.\n\n<task_metadata>\nsession_id: ${sessionId}\n</task_metadata>`;
  } catch (e) {
    log.error(LOG.TOOL, `Failed to fetch spawn output`, {
      sessionId,
      alias,
      error: String(e),
    });
    return `Agent ${alias} completed.\nSession: ${sessionId}`;
  }
}

/**
 * Mark a spawned task as completed in the parent session's TUI.
 * Updates the task part status from "running" to "completed".
 *
 * IMPORTANT: Does NOT expose the full output to main session's LLM context.
 * The full output is piped to the caller (subagent) only.
 * Main session just sees a completion summary in its TUI.
 */
export async function markSpawnCompleted(
  client: OpenCodeSessionClient,
  spawn: SpawnInfo,
): Promise<boolean> {
  if (!spawn.partId || !spawn.parentMessageId || !spawn.parentSessionId) {
    log.warn(LOG.TOOL, `Cannot mark spawn completed - missing part info`, {
      alias: spawn.alias,
      hasPartId: !!spawn.partId,
      hasMessageId: !!spawn.parentMessageId,
      hasSessionId: !!spawn.parentSessionId,
    });
    return false;
  }

  const now = Date.now();

  // If we don't have part info (no immediate injection was done), inject now
  if (!spawn.partId || !spawn.parentMessageId || !spawn.parentSessionId) {
    // Get the parent session ID from the spawned session
    const parentId =
      spawn.parentSessionId ||
      (await getParentIdForSpawn(client, spawn.sessionId));
    if (!parentId) {
      log.warn(LOG.TOOL, `Cannot mark spawn completed - no parent session`, {
        alias: spawn.alias,
      });
      return false;
    }

    // Get the last assistant message to attach the completed part
    const messagesResult = await client.session.messages({
      path: { id: parentId },
    });

    const messages = messagesResult.data;
    if (!messages || messages.length === 0) {
      log.warn(
        LOG.TOOL,
        `No messages in parent session for completion injection`,
        {
          parentId,
          alias: spawn.alias,
        },
      );
      return false;
    }

    const lastAssistantMsg = [...messages]
      .reverse()
      .find((m) => m.info.role === "assistant");

    if (!lastAssistantMsg) {
      log.warn(LOG.TOOL, `No assistant message for completion injection`, {
        parentId,
        alias: spawn.alias,
      });
      return false;
    }

    // Set the part info for this completion
    spawn.partId = `prt_spwn_${spawn.sessionId.slice(-12)}_${now}`;
    spawn.parentMessageId = lastAssistantMsg.info.id;
    spawn.parentSessionId = parentId;
  }

  // Summary only - full output is piped to the caller, not stored here
  const summaryOutput = `Agent ${spawn.alias} completed successfully.\nOutput was piped to the caller.\n\n<task_metadata>\nsession_id: ${spawn.sessionId}\n</task_metadata>`;

  const completedPart = {
    id: spawn.partId,
    sessionID: spawn.parentSessionId,
    messageID: spawn.parentMessageId,
    type: "tool",
    callID: `call_spwn_${spawn.sessionId.slice(-12)}`,
    tool: "task",
    state: {
      status: "completed",
      input: {
        description: spawn.description,
        prompt: spawn.prompt,
        subagent_type: "general",
      },
      output: summaryOutput,
      title: spawn.description,
      metadata: {
        sessionId: spawn.sessionId,
        spawned_by_pocket_universe: true,
      },
      time: { start: spawn.timestamp, end: now },
    },
  };

  try {
    const httpClient = (client as unknown as { client?: InternalClient })
      .client;
    const altClient = (client as unknown as { _client?: InternalClient })
      ._client;
    const patchClient = httpClient?.patch
      ? httpClient
      : altClient?.patch
        ? altClient
        : null;

    if (!patchClient?.patch) {
      log.warn(LOG.TOOL, `No HTTP client for marking spawn completed`);
      return false;
    }

    await patchClient.patch({
      url: `/session/${spawn.parentSessionId}/message/${spawn.parentMessageId}/part/${spawn.partId}`,
      body: completedPart,
    });

    log.info(LOG.TOOL, `Spawn marked as completed`, {
      alias: spawn.alias,
      partId: spawn.partId,
    });

    // Clean up from active spawns
    activeSpawns.delete(spawn.sessionId);
    return true;
  } catch (e) {
    log.error(LOG.TOOL, `Failed to mark spawn completed`, {
      alias: spawn.alias,
      error: String(e),
    });
    return false;
  }
}
