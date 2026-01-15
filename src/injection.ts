// =============================================================================
// Injection helpers for synthetic message creation and TUI updates
// =============================================================================

import type {
  Message,
  OpenCodeSessionClient,
  UserMessage,
  AssistantMessage,
  SubagentInfo,
  InternalClient,
} from "./types";
import type { ParallelAgent } from "./prompt";
import {
  ANNOUNCE_HINT,
  agentCompletedMessage,
  agentCompletedWithSummary,
  subagentCompletedSummary,
  subagentRunningMessage,
  taskOutputWithMetadata,
  subagentTaskOutput,
  POCKET_UNIVERSE_SUMMARY_HEADER,
  POCKET_UNIVERSE_AGENTS_INTRO,
  WORKTREE_MERGE_NOTE,
  WORKTREE_SUMMARY_HEADER,
  WORKTREE_SUMMARY_NOTE,
} from "./prompt";
import { log, LOG } from "./logger";
import {
  sessionParentCache,
  childSessionCache,
  activeSubagents,
  sessionWorktrees,
  sessionToAlias,
  agentDescriptions,
  getStoredClient,
  cleanupCompletedAgents,
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

// =============================================================================
// Main Session Cover Message
// =============================================================================

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
  // Generate the full summary
  const summary = generatePocketUniverseSummary();
  if (!summary) {
    return null;
  }

  // Find the last user message to extract info
  const lastUserMsg = [...messages]
    .reverse()
    .find((m) => (m as { info?: { role?: string } }).info?.role === "user") as
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
      role: "assistant",
      agent: lastUserMsg.info.agent || "code",
      parentID: lastUserMsg.info.id,
      modelID: lastUserMsg.info.model?.modelID || DEFAULT_MODEL_ID,
      providerID: lastUserMsg.info.model?.providerID || DEFAULT_PROVIDER_ID,
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
        id: `${syntheticId}-p`,
        sessionID: sessionId,
        messageID: syntheticId,
        type: "tool",
        callID: `${syntheticId}-c`,
        tool: "pocket_universe",
        state: {
          status: "completed",
          input: { synthetic: true },
          output: summary,
          title: "Pocket Universe Summary",
          metadata: {},
          time: { start: now, end: now },
        },
      },
    ],
  };
}

// =============================================================================
// Inbox Message Creation (for child sessions)
// =============================================================================

/**
 * Create a synthetic broadcast message showing inbox and agent status.
 * This is injected into child sessions before each LLM call.
 */
export function createInboxMessage(
  sessionId: string,
  messages: Message[],
  lastUserMessage: UserMessage,
  parallelAgents: ParallelAgent[],
  hasAnnounced: boolean,
  selfAlias: string,
): AssistantMessage {
  const now = Date.now();
  const userInfo = lastUserMessage.info;

  // Build structured output - this is what the LLM sees as the "tool result"
  // Agents section shows available agents and their status history (not replyable)
  // Messages section shows replyable messages
  const outputData: {
    you_are: string;
    hint?: string;
    agents?: Array<{ name: string; status?: string[]; worktree?: string }>;
    messages?: Array<{ id: number; from: string; content: string }>;
  } = {
    you_are: selfAlias,
  };

  // Add hint for first-time callers
  if (!hasAnnounced) {
    outputData.hint = ANNOUNCE_HINT;
  }

  // Build agents section from parallelAgents (status comes from agentDescriptions)
  if (parallelAgents.length > 0) {
    outputData.agents = parallelAgents.map((agent) => ({
      name: agent.alias,
      status: agent.description, // Now an array of status updates
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
    agentStatuses: parallelAgents.map((a) =>
      a.description?.slice(-2).join(", "),
    ),
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
    description: string[] | undefined;
    worktree: string;
  }> = [];

  for (const [sessId, worktreePath] of sessionWorktrees.entries()) {
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
      task: w.description || "unknown",
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
 * This makes subagent sessions appear as task tool calls in the parent's history
 */
export function createSubagentTaskMessage(
  parentSessionId: string,
  subagent: SubagentInfo,
  baseUserMessage: UserMessage,
): AssistantMessage {
  const now = Date.now();
  const userInfo = baseUserMessage.info;

  const assistantMessageId = `msg_sub_${subagent.sessionId.slice(-12)}`;
  const partId = `prt_sub_${subagent.sessionId.slice(-12)}`;
  const callId = `call_sub_${subagent.sessionId.slice(-12)}`;

  // Build output similar to what task tool produces
  const output = subagentTaskOutput(
    subagent.alias,
    subagent.description,
    subagent.sessionId,
  );

  log.info(LOG.MESSAGE, `Creating synthetic task injection`, {
    parentSessionId,
    subagentAlias: subagent.alias,
    subagentSessionId: subagent.sessionId,
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
      time: { created: subagent.timestamp, completed: now },
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
            description: subagent.description,
            prompt: subagent.prompt,
            subagent_type: "general",
            synthetic: true, // Indicates this was created by Pocket Universe
          },
          output,
          title: subagent.description,
          metadata: {
            sessionId: subagent.sessionId,
            created_by_pocket_universe: true,
          },
          time: { start: subagent.timestamp, end: now },
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
 * This makes the subagent task visible in the TUI immediately.
 * Uses the internal HTTP client (client.client) to PATCH the part.
 */
export async function injectTaskPartToParent(
  client: OpenCodeSessionClient,
  parentSessionId: string,
  subagent: SubagentInfo,
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
    const partId = `prt_sub_${subagent.sessionId.slice(-12)}_${now}`;
    const callId = `call_sub_${subagent.sessionId.slice(-12)}`;

    // Store part info in subagent for later completion update
    subagent.partId = partId;
    subagent.parentMessageId = messageId;
    subagent.parentSessionId = parentSessionId;

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
          description: subagent.description,
          prompt: subagent.prompt,
          subagent_type: "general",
        },
        output: subagentRunningMessage(subagent.alias, subagent.sessionId),
        title: subagent.description,
        metadata: {
          sessionId: subagent.sessionId,
          created_by_pocket_universe: true,
        },
        time: { start: subagent.timestamp, end: 0 }, // end=0 indicates still running
      },
    };

    log.info(LOG.TOOL, `Injecting task part to parent`, {
      parentSessionId,
      messageId,
      partId,
      subagentAlias: subagent.alias,
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
          subagentAlias: subagent.alias,
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
      subagentAlias: subagent.alias,
    });
    return true;
  } catch (e) {
    log.error(LOG.TOOL, `Failed to inject task part`, {
      parentSessionId,
      subagentAlias: subagent.alias,
      error: String(e),
    });
    return false;
  }
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

/**
 * Fetch the actual output from a subagent session.
 * Mimics how the native Task tool extracts the last text part.
 */
export async function fetchSubagentOutput(
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
      log.warn(LOG.TOOL, `No messages found in subagent session`, {
        sessionId,
        alias,
      });
      return agentCompletedMessage(alias, sessionId);
    }

    // Find assistant messages and extract text parts (like native Task tool does)
    const assistantMessages = messages.filter(
      (m) => m.info.role === "assistant",
    );

    if (assistantMessages.length === 0) {
      log.warn(LOG.TOOL, `No assistant messages in subagent session`, {
        sessionId,
        alias,
      });
      return agentCompletedMessage(alias, sessionId);
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
      log.info(LOG.TOOL, `Extracted output from subagent session`, {
        sessionId,
        alias,
        textLength: text.length,
      });
      // Format like native Task tool does
      return taskOutputWithMetadata(text, sessionId);
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
      return agentCompletedWithSummary(alias, summary, sessionId);
    }

    return taskOutputWithMetadata(`Agent ${alias} completed.`, sessionId);
  } catch (e) {
    log.error(LOG.TOOL, `Failed to fetch subagent output`, {
      sessionId,
      alias,
      error: String(e),
    });
    return agentCompletedMessage(alias, sessionId);
  }
}

/**
 * Mark a subagent task as completed in the parent session's TUI.
 * Updates the task part status from "running" to "completed".
 *
 * IMPORTANT: Does NOT expose the full output to main session's LLM context.
 * The full output is piped to the caller (subagent) only.
 * Main session just sees a completion summary in its TUI.
 */
export async function markSubagentCompleted(
  client: OpenCodeSessionClient,
  subagent: SubagentInfo,
): Promise<boolean> {
  if (
    !subagent.partId ||
    !subagent.parentMessageId ||
    !subagent.parentSessionId
  ) {
    log.warn(LOG.TOOL, `Cannot mark subagent completed - missing part info`, {
      alias: subagent.alias,
      hasPartId: !!subagent.partId,
      hasMessageId: !!subagent.parentMessageId,
      hasSessionId: !!subagent.parentSessionId,
    });
    return false;
  }

  const now = Date.now();

  // If we don't have part info (no immediate injection was done), inject now
  if (
    !subagent.partId ||
    !subagent.parentMessageId ||
    !subagent.parentSessionId
  ) {
    // Get the parent session ID from the subagent session
    const parentId =
      subagent.parentSessionId ||
      (await getParentIdForSubagent(client, subagent.sessionId));
    if (!parentId) {
      log.warn(LOG.TOOL, `Cannot mark subagent completed - no parent session`, {
        alias: subagent.alias,
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
          alias: subagent.alias,
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
        alias: subagent.alias,
      });
      return false;
    }

    // Set the part info for this completion
    subagent.partId = `prt_sub_${subagent.sessionId.slice(-12)}_${now}`;
    subagent.parentMessageId = lastAssistantMsg.info.id;
    subagent.parentSessionId = parentId;
  }

  // Summary only - full output is piped to the caller, not stored here
  const summaryOutput = subagentCompletedSummary(
    subagent.alias,
    subagent.sessionId,
  );

  const completedPart = {
    id: subagent.partId,
    sessionID: subagent.parentSessionId,
    messageID: subagent.parentMessageId,
    type: "tool",
    callID: `call_sub_${subagent.sessionId.slice(-12)}`,
    tool: "task",
    state: {
      status: "completed",
      input: {
        description: subagent.description,
        prompt: subagent.prompt,
        subagent_type: "general",
      },
      output: summaryOutput,
      title: subagent.description,
      metadata: {
        sessionId: subagent.sessionId,
        created_by_pocket_universe: true,
      },
      time: { start: subagent.timestamp, end: now },
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
      log.warn(LOG.TOOL, `No HTTP client for marking subagent completed`);
      return false;
    }

    await patchClient.patch({
      url: `/session/${subagent.parentSessionId}/message/${subagent.parentMessageId}/part/${subagent.partId}`,
      body: completedPart,
    });

    log.info(LOG.TOOL, `Subagent marked as completed`, {
      alias: subagent.alias,
      partId: subagent.partId,
    });

    // Clean up from active subagents
    activeSubagents.delete(subagent.sessionId);
    return true;
  } catch (e) {
    log.error(LOG.TOOL, `Failed to mark subagent completed`, {
      alias: subagent.alias,
      error: String(e),
    });
    return false;
  }
}

// =============================================================================
// Pocket Universe Summary (persisted to main session)
// =============================================================================

/**
 * Generate a Pocket Universe Summary for the main session.
 * This summarizes all agents, their status history, and worktree paths.
 * Called when all parallel work is complete, before returning to main session.
 */
export function generatePocketUniverseSummary(): string | null {
  // Collect all agents from sessionToAlias
  // Note: Only child sessions (subagents) have aliases, so all entries are agents
  const agents: Array<{
    alias: string;
    statuses: string[];
    worktree: string | undefined;
  }> = [];

  for (const [sessionId, alias] of sessionToAlias.entries()) {
    const statuses = agentDescriptions.get(alias) || [];
    const worktree = isWorktreeEnabled()
      ? sessionWorktrees.get(sessionId)
      : undefined;

    agents.push({ alias, statuses, worktree });
  }

  // If no agents, no summary needed
  if (agents.length === 0) {
    return null;
  }

  // Build the summary
  const lines: string[] = [];
  lines.push(POCKET_UNIVERSE_SUMMARY_HEADER);
  lines.push(``);
  lines.push(POCKET_UNIVERSE_AGENTS_INTRO);
  lines.push(``);

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
    lines.push(``);
  }

  if (isWorktreeEnabled()) {
    lines.push(WORKTREE_MERGE_NOTE);
  }

  return lines.join("\n");
}

/**
 * Inject the Pocket Universe Summary as a persisted SYNTHETIC user message into the main session.
 * Uses noReply: true to prevent AI loop, and synthetic: true to hide from TUI.
 * The message is persisted to the database but not visible to the user.
 */
export async function injectPocketUniverseSummaryToMain(
  mainSessionId: string,
): Promise<boolean> {
  const storedClient = getStoredClient();
  if (!storedClient) {
    log.warn(LOG.SESSION, `Cannot inject summary - no client available`);
    return false;
  }

  const summary = generatePocketUniverseSummary();
  if (!summary) {
    log.info(
      LOG.SESSION,
      `No agents to summarize, skipping pocket universe summary`,
    );
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
        parts: [{ type: "text", text: summary, synthetic: true }],
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
