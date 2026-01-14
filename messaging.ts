// =============================================================================
// Core messaging functions, session utilities, and injection helpers
// =============================================================================

import type {
  Message,
  OpenCodeSessionClient,
  UserMessage,
  AssistantMessage,
  SpawnInfo,
  InternalClient,
} from "./types";
import type { ParallelAgent, HandledMessage } from "./prompt";
import { log, LOG } from "./logger";
import {
  inboxes,
  sessionToAlias,
  aliasToSession,
  activeSessions,
  agentDescriptions,
  sessionParentCache,
  childSessionCache,
  presentedMessages,
  sessionStates,
  activeSpawns,
  getStoredClient,
  getAlias,
  getDescription,
  generateId,
  getNextMsgIndex,
  getInbox,
  PARENT_CACHE_TTL_MS,
  MAX_INBOX_SIZE,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
} from "./state";

// ============================================================================
// Core messaging functions
// ============================================================================

export function sendMessage(from: string, to: string, body: string): Message {
  const message: Message = {
    id: generateId(),
    msgIndex: getNextMsgIndex(to),
    from,
    to,
    body,
    timestamp: Date.now(),
    handled: false,
  };

  const queue = getInbox(to);

  // Enforce max queue size
  if (queue.length >= MAX_INBOX_SIZE) {
    // Remove oldest handled message, or oldest message if all unhandled
    const handledIndex = queue.findIndex((m) => m.handled);
    if (handledIndex !== -1) {
      queue.splice(handledIndex, 1);
    } else {
      queue.shift();
    }
    log.warn(LOG.MESSAGE, `Queue full, removed oldest message`, { to });
  }

  queue.push(message);
  log.info(LOG.MESSAGE, `Message sent`, {
    id: message.id,
    msgIndex: message.msgIndex,
    from,
    to,
    bodyLength: body.length,
  });
  return message;
}

/**
 * Resume an idle session by sending a broadcast message as a user prompt.
 * This "wakes up" the idle agent to process the message.
 */
export async function resumeSessionWithBroadcast(
  recipientSessionId: string,
  senderAlias: string,
  messageContent: string,
): Promise<boolean> {
  const storedClient = getStoredClient();
  if (!storedClient) {
    log.warn(LOG.MESSAGE, `Cannot resume session - no client available`);
    return false;
  }

  const recipientAlias = sessionToAlias.get(recipientSessionId) || "unknown";

  log.info(LOG.MESSAGE, `Resuming idle session with broadcast`, {
    recipientSessionId,
    recipientAlias,
    senderAlias,
    messageLength: messageContent.length,
  });

  try {
    // Format the resume prompt - DON'T include full message content
    // because the synthetic injection will show it. Just notify that new messages arrived.
    const resumePrompt = `[Broadcast from ${senderAlias}]: New message received. Check your inbox.`;

    // Mark session as active before resuming
    const state = sessionStates.get(recipientSessionId);
    if (state) {
      state.status = "active";
      state.lastActivity = Date.now();
    }

    log.info(LOG.MESSAGE, `Session resumed successfully`, {
      recipientSessionId,
      recipientAlias,
    });

    // Fire off the resume in the background but track its completion
    // We use prompt() (not promptAsync) and await it so we know when it finishes
    // This is wrapped in an IIFE so we don't block the caller
    (async () => {
      try {
        await storedClient!.session.prompt({
          path: { id: recipientSessionId },
          body: {
            parts: [{ type: "text", text: resumePrompt }],
          },
        });

        // Mark session as idle after prompt completes
        const stateAfter = sessionStates.get(recipientSessionId);
        if (stateAfter) {
          stateAfter.status = "idle";
          stateAfter.lastActivity = Date.now();
        }

        log.info(LOG.MESSAGE, `Resumed session completed, marked idle`, {
          recipientSessionId,
          recipientAlias,
        });

        // Check for messages that need resumption (unhandled AND not presented)
        const unreadMessages = getMessagesNeedingResume(recipientSessionId);
        if (unreadMessages.length > 0) {
          log.info(
            LOG.MESSAGE,
            `Resumed session has new unread messages, resuming again`,
            {
              recipientSessionId,
              recipientAlias,
              unreadCount: unreadMessages.length,
            },
          );

          // Resume with the first unread message
          const firstUnread = unreadMessages[0];
          const senderAlias = firstUnread.from;

          // Mark this message as presented BEFORE resuming to avoid infinite loop
          markMessagesAsPresented(recipientSessionId, [firstUnread.msgIndex]);

          await resumeSessionWithBroadcast(
            recipientSessionId,
            senderAlias,
            firstUnread.body,
          );
        }
      } catch (e) {
        log.error(LOG.MESSAGE, `Resumed session failed`, {
          recipientSessionId,
          error: String(e),
        });
        // Mark as idle on error too
        const stateErr = sessionStates.get(recipientSessionId);
        if (stateErr) {
          stateErr.status = "idle";
        }
      }
    })();

    return true;
  } catch (e) {
    log.error(LOG.MESSAGE, `Failed to resume session`, {
      recipientSessionId,
      error: String(e),
    });
    return false;
  }
}

export function getUnhandledMessages(sessionId: string): Message[] {
  return getInbox(sessionId).filter((m) => !m.handled);
}

/**
 * Get messages that need resumption: unhandled AND not presented via transform.
 * - Unhandled: agent didn't use reply_to to respond
 * - Not presented: agent didn't see the message in their context (via transform injection)
 * Only these messages should trigger a resume - they're truly "unseen" by the agent.
 */
export function getMessagesNeedingResume(sessionId: string): Message[] {
  const unhandled = getUnhandledMessages(sessionId);
  const presented = presentedMessages.get(sessionId);
  if (!presented || presented.size === 0) {
    return unhandled; // No messages were presented, all unhandled need resume
  }
  // Filter out messages that were already presented to the agent
  return unhandled.filter((m) => !presented.has(m.msgIndex));
}

export function markMessagesAsHandled(
  sessionId: string,
  msgIndices: number[],
): HandledMessage[] {
  const queue = getInbox(sessionId);
  const handled: HandledMessage[] = [];
  for (const msg of queue) {
    if (msgIndices.includes(msg.msgIndex) && !msg.handled) {
      msg.handled = true;
      handled.push({
        id: msg.msgIndex,
        from: msg.from,
        body: msg.body,
      });
      log.info(LOG.MESSAGE, `Message marked as handled`, {
        sessionId,
        msgIndex: msg.msgIndex,
        from: msg.from,
      });
    }
  }
  return handled;
}

export function markMessagesAsPresented(
  sessionId: string,
  msgIndices: number[],
): void {
  let presented = presentedMessages.get(sessionId);
  if (!presented) {
    presented = new Set();
    presentedMessages.set(sessionId, presented);
  }
  for (const idx of msgIndices) {
    presented.add(idx);
  }
  log.debug(LOG.MESSAGE, `Marked messages as presented (seen by agent)`, {
    sessionId,
    indices: msgIndices,
  });
}

export function getKnownAliases(sessionId: string): string[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const agents: string[] = [];
  for (const alias of aliasToSession.keys()) {
    if (alias !== selfAlias) {
      agents.push(alias);
    }
  }
  return agents;
}

export function getParallelAgents(sessionId: string): ParallelAgent[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const agents: ParallelAgent[] = [];
  for (const [alias] of aliasToSession.entries()) {
    // All registered sessions are child sessions (we check parentID before registering)
    // Just exclude self
    if (alias !== selfAlias) {
      agents.push({
        alias,
        description: getDescription(alias),
      });
    }
  }
  return agents;
}

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
    agents?: Array<{ name: string; status?: string }>;
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
 */
export async function markSpawnCompleted(
  client: OpenCodeSessionClient,
  spawn: SpawnInfo,
  output?: string,
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

  // Fetch actual output from the spawned session if not provided
  let finalOutput = output;
  if (!finalOutput) {
    finalOutput = await fetchSpawnOutput(client, spawn.sessionId, spawn.alias);
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
      output: finalOutput,
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
