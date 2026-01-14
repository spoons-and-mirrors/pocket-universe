import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  BROADCAST_SELF_MESSAGE,
  broadcastUnknownRecipient,
  broadcastResult,
  SPAWN_DESCRIPTION,
  SPAWN_NOT_CHILD_SESSION,
  SPAWN_MISSING_PROMPT,
  spawnResult,
  SYSTEM_PROMPT,
  type ParallelAgent,
  type HandledMessage,
} from "./prompt";
import { log, LOG } from "./logger";

// ============================================================================
// Constants
// ============================================================================

const CHAR_CODE_A = 65; // ASCII code for 'A'
const ALPHABET_SIZE = 26;
const MAX_DESCRIPTION_LENGTH = 300;
const MESSAGE_TTL_MS = 30 * 60 * 1000; // 30 minutes for handled messages
const UNHANDLED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for unhandled messages
const MAX_INBOX_SIZE = 100; // Max messages per inbox
const PARENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes // DORMANT: parent alias feature // DORMANT: parent alias feature
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute
const DEFAULT_MODEL_ID = "gpt-4o-2024-08-06";
const DEFAULT_PROVIDER_ID = "openai";
const MAX_MESSAGE_LENGTH = 10000; // Prevent excessively long messages

// ============================================================================
// Types
// ============================================================================

interface Message {
  id: string; // Internal ID (random string)
  msgIndex: number; // Numeric index for display (1-based, per session)
  from: string;
  to: string;
  body: string;
  timestamp: number;
  handled: boolean;
}

// DORMANT: parent alias feature
interface CachedParentId {
  value: string | null;
  cachedAt: number;
}

/** Minimal interface for OpenCode SDK client session API */
interface OpenCodeSessionClient {
  session: {
    get: (params: {
      path: { id: string };
    }) => Promise<{ data?: { parentID?: string } }>;
    create: (params: {
      body?: { parentID?: string; title?: string };
    }) => Promise<{ data?: { id: string } }>;
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: { id: string; role: string; sessionID: string };
        parts?: unknown[];
      }>;
    }>;
    prompt: (params: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text?: string }>;
        agent?: string;
        model?: { modelID?: string; providerID?: string };
      };
    }) => Promise<{ data?: unknown; error?: unknown }>;
    promptAsync: (params: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text?: string }>;
        agent?: string;
        model?: { modelID?: string; providerID?: string };
      };
    }) => Promise<{ data?: unknown }>;
  };
  part: {
    update: (params: {
      path: { sessionID: string; messageID: string; partID: string };
      body: {
        id: string;
        sessionID: string;
        messageID: string;
        type: string;
        prompt?: string;
        description?: string;
        agent?: string;
      };
    }) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

/** Internal client interface (accessed via type assertion) */
interface InternalClient {
  post?: (params: { url: string; body: unknown }) => Promise<unknown>;
  patch?: (params: { url: string; body: unknown }) => Promise<unknown>;
}

/** Message info from OpenCode SDK */
interface MessageInfo {
  id: string;
  sessionID: string;
  role: string;
  agent?: string;
  model?: {
    modelID?: string;
    providerID?: string;
  };
  variant?: unknown;
}

/** User message structure from OpenCode SDK */
interface UserMessage {
  info: MessageInfo;
  parts: unknown[];
}

/** Tool execution context */
interface ToolContext {
  sessionID: string;
}

/** Hook input for tool.execute.after */
interface ToolExecuteInput {
  tool: string;
  sessionID: string;
}

/** Hook output for tool.execute.after */
interface ToolExecuteOutput {
  metadata?: {
    sessionId?: string;
    session_id?: string;
  };
  output?: string;
}

/** Hook input for system.transform */
interface SystemTransformInput {
  sessionID?: string;
}

/** Hook output for system.transform */
interface SystemTransformOutput {
  system: string[];
}

/** Hook output for messages.transform */
interface MessagesTransformOutput {
  messages: UserMessage[];
}

/** Hook output for config.transform */
interface ConfigTransformOutput {
  experimental?: {
    subagent_tools?: string[];
    [key: string]: unknown;
  };
}

// ============================================================================
// In-memory message store
// ============================================================================

// Inboxes indexed by recipient session ID
const inboxes = new Map<string, Message[]>();

// Message index counter per session (for numeric IDs)
const sessionMsgCounter = new Map<string, number>();

// Track ALL active sessions
const activeSessions = new Set<string>();

// Track sessions that have announced themselves (called broadcast at least once)
const announcedSessions = new Set<string>();

// Alias mappings: sessionId <-> alias (e.g., "agentA", "agentB")
const sessionToAlias = new Map<string, string>();
const aliasToSession = new Map<string, string>();
const agentDescriptions = new Map<string, string>(); // alias -> description

// Atomic alias counter with registration lock
let nextAgentIndex = 0;
const registeringSessionsLock = new Set<string>(); // Prevent race conditions

// DORMANT: parent alias feature
// Cache for parentID lookups with expiry
const sessionParentCache = new Map<string, CachedParentId>();

// Cache for child session checks (fast path)
const childSessionCache = new Set<string>();

// Store pending task descriptions by parent session ID
// parentSessionId -> array of descriptions (most recent last)
const pendingTaskDescriptions = new Map<string, string[]>();

// Track messages that were presented to an agent via transform injection
// These are different from "handled" messages (which are explicitly replied to via reply_to)
// Presented messages: agent saw them in context, may or may not have responded
// Handled messages: agent explicitly used reply_to to respond
// Key: sessionId, Value: Set of msgIndex that were presented
const presentedMessages = new Map<string, Set<number>>();
// Track spawned sessions that need to be injected into parent's message history
// Maps parentSessionId -> array of spawn info
interface SpawnInfo {
  sessionId: string;
  alias: string;
  description: string;
  prompt: string;
  timestamp: number;
  injected: boolean;
  // For updating the task part when spawn completes
  partId?: string;
  parentMessageId?: string;
  parentSessionId?: string;
}
const pendingSpawns = new Map<string, SpawnInfo[]>();

// Track active spawns by sessionId for completion updates
const activeSpawns = new Map<string, SpawnInfo>();

// Track pending spawns per CALLER session (not parent)
// When agentA spawns agentB, we track that agentA has a pending spawn
// This allows us to keep agentA alive until agentB completes
// Key: caller session ID, Value: Set of spawned session IDs
const callerPendingSpawns = new Map<string, Set<string>>();

// ============================================================================
// Session State Tracking (for broadcast resumption)
// ============================================================================

interface SessionState {
  sessionId: string;
  alias: string;
  status: "active" | "idle";
  lastActivity: number;
}

// Track session states for resumption
const sessionStates = new Map<string, SessionState>();

// Store the client reference for resumption calls
let storedClient: OpenCodeSessionClient | null = null;

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

function getNextAlias(): string {
  const index = nextAgentIndex;
  nextAgentIndex++;

  const letter = String.fromCharCode(CHAR_CODE_A + (index % ALPHABET_SIZE));
  const suffix =
    index >= ALPHABET_SIZE ? Math.floor(index / ALPHABET_SIZE).toString() : "";
  return `agent${letter}${suffix}`;
}

function getAlias(sessionId: string): string {
  return sessionToAlias.get(sessionId) || sessionId;
}

function setDescription(sessionId: string, description: string): void {
  const alias = getAlias(sessionId);
  const truncated = description.substring(0, MAX_DESCRIPTION_LENGTH);
  agentDescriptions.set(alias, truncated);
  log.info(LOG.SESSION, `Agent announced`, { alias, description: truncated });
}

function getDescription(alias: string): string | undefined {
  return agentDescriptions.get(alias);
}

function resolveAlias(
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

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function getNextMsgIndex(sessionId: string): number {
  const current = sessionMsgCounter.get(sessionId) || 0;
  const next = current + 1;
  sessionMsgCounter.set(sessionId, next);
  return next;
}

function getInbox(sessionId: string): Message[] {
  if (!inboxes.has(sessionId)) {
    inboxes.set(sessionId, []);
  }
  return inboxes.get(sessionId)!;
}

// ============================================================================
// Core messaging functions
// ============================================================================

function sendMessage(from: string, to: string, body: string): Message {
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
async function resumeSessionWithBroadcast(
  recipientSessionId: string,
  senderAlias: string,
  messageContent: string,
): Promise<boolean> {
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

function getUnhandledMessages(sessionId: string): Message[] {
  return getInbox(sessionId).filter((m) => !m.handled);
}

/**
 * Get messages that need resumption: unhandled AND not presented via transform.
 * - Unhandled: agent didn't use reply_to to respond
 * - Not presented: agent didn't see the message in their context (via transform injection)
 * Only these messages should trigger a resume - they're truly "unseen" by the agent.
 */
function getMessagesNeedingResume(sessionId: string): Message[] {
  const unhandled = getUnhandledMessages(sessionId);
  const presented = presentedMessages.get(sessionId);
  if (!presented || presented.size === 0) {
    return unhandled; // No messages were presented, all unhandled need resume
  }
  // Filter out messages that were already presented to the agent
  return unhandled.filter((m) => !presented.has(m.msgIndex));
}

function markMessagesAsHandled(
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

function markMessagesAsPresented(sessionId: string, msgIndices: number[]) {
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

function getKnownAliases(sessionId: string): string[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const agents: string[] = [];
  for (const alias of aliasToSession.keys()) {
    if (alias !== selfAlias) {
      agents.push(alias);
    }
  }
  return agents;
}

function getParallelAgents(sessionId: string): ParallelAgent[] {
  const selfAlias = sessionToAlias.get(sessionId);
  const agents: ParallelAgent[] = [];
  for (const [alias, sessId] of aliasToSession.entries()) {
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

function registerSession(sessionId: string): void {
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
// Session utils
// ============================================================================

// DORMANT: parent alias feature
async function getParentId(
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
async function isChildSession(
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

interface AssistantMessage {
  info: {
    id: string;
    sessionID: string;
    role: string;
    agent: string;
    parentID: string;
    modelID: string;
    providerID: string;
    mode: string;
    path: { cwd: string; root: string };
    time: { created: number; completed: number };
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    variant?: unknown;
  };
  parts: Array<{
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    callID: string;
    tool: string;
    state: {
      status: string;
      input: Record<string, unknown>;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number };
    };
  }>;
}

function createInboxMessage(
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
          input: { synthetic: true }, // Hints this was injected by IAM, not a real agent call
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
function createSpawnTaskMessage(
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
            synthetic: true, // Indicates this was spawned by IAM
          },
          output,
          title: spawn.description,
          metadata: {
            sessionId: spawn.sessionId,
            spawned_by_iam: true,
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
async function injectTaskPartToParent(
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
          spawned_by_iam: true,
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
        await (altClient as any).patch({
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

    await (httpClient as any).patch({
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
async function getParentIdForSpawn(
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
async function fetchSpawnOutput(
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
async function markSpawnCompleted(
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
        spawned_by_iam: true,
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

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized");
  const client = ctx.client as unknown as OpenCodeSessionClient;
  const serverUrl = ctx.serverUrl; // Server URL for raw fetch calls

  // Store client for resumption calls
  storedClient = client;

  return {
    // Track session idle events for broadcast resumption AND spawn completion
    "session.idle": async ({ sessionID }: { sessionID: string }) => {
      // Check if this is a registered IAM session (child session)
      const alias = sessionToAlias.get(sessionID);
      const isRegistered = activeSessions.has(sessionID);
      const hasPendingSpawns = callerPendingSpawns.has(sessionID);
      const pendingCount = callerPendingSpawns.get(sessionID)?.size || 0;

      log.info(LOG.SESSION, `session.idle hook fired`, {
        sessionID,
        alias: alias || "unknown",
        isRegistered,
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
          const output = await fetchSpawnOutput(client, sessionID, spawn.alias);
          await markSpawnCompleted(client, spawn, output);
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
          const pendingSpawns = callerPendingSpawns.get(subtaskSessionId);
          if (pendingSpawns && pendingSpawns.size > 0) {
            log.warn(
              LOG.SESSION,
              `Task completing but has pending spawns! Main will continue early.`,
              {
                subtaskSessionId,
                alias,
                pendingSpawnCount: pendingSpawns.size,
                pendingSpawnIds: Array.from(pendingSpawns),
              },
            );
            // TODO: Find a way to prevent this - main session will continue
            // before spawned agents complete
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
          // This handles the race condition where a message arrives
          // after the session's last transform but before it completes
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
      broadcast: tool({
        description: BROADCAST_DESCRIPTION,
        args: {
          send_to: tool.schema
            .string()
            .optional()
            .describe("Target agent (single agent only). Omit to send to all."),
          message: tool.schema.string().describe("Your message"),
          reply_to: tool.schema
            .number()
            .optional()
            .describe("Message ID to mark as handled"),
        },
        async execute(args, context: ToolContext) {
          const sessionId = context.sessionID;

          // Check if this is the first broadcast call (agent announcing themselves)
          // This is separate from session registration which happens earlier in system.transform
          const isFirstCall = !announcedSessions.has(sessionId);

          // Register if not already (should already be registered via system.transform)
          registerSession(sessionId);

          const alias = getAlias(sessionId);

          if (!args.message) {
            log.warn(LOG.TOOL, `broadcast missing 'message'`, { alias });
            return BROADCAST_MISSING_MESSAGE;
          }

          // Truncate message if too long (don't error - just truncate)
          let messageContent = args.message;
          if (messageContent.length > MAX_MESSAGE_LENGTH) {
            log.warn(LOG.TOOL, `broadcast message truncated`, {
              alias,
              originalLength: messageContent.length,
              truncatedTo: MAX_MESSAGE_LENGTH,
            });
            messageContent =
              messageContent.substring(0, MAX_MESSAGE_LENGTH) +
              "... [truncated]";
          }

          // Get parallel agents info early (needed for first call)
          const parallelAgents = getParallelAgents(sessionId);

          log.info(LOG.TOOL, `broadcast called`, {
            alias,
            send_to: args.send_to,
            reply_to: args.reply_to,
            messageLength: messageContent.length,
            isFirstCall,
          });

          // First call logic: announce the agent
          // BUT if reply_to is provided, skip status announcement and treat as normal reply
          if (isFirstCall && args.reply_to === undefined) {
            // Mark this session as having announced
            announcedSessions.add(sessionId);

            setDescription(sessionId, messageContent);

            const knownAgents = getKnownAliases(sessionId);

            // Status is now stored in agentDescriptions - no need to send as message
            // Other agents will see it via parallelAgents in the synthetic injection

            log.info(LOG.TOOL, `First broadcast - status announcement`, {
              alias,
              status: messageContent.substring(0, 80),
              discoveredAgents: knownAgents,
            });

            // Check if any discovered agents are idle and resume them
            // so they can see this new agent's announcement
            for (const knownAlias of knownAgents) {
              const knownSessionId = aliasToSession.get(knownAlias);
              if (knownSessionId) {
                const knownState = sessionStates.get(knownSessionId);
                if (knownState?.status === "idle") {
                  log.info(
                    LOG.TOOL,
                    `Resuming idle agent on status announcement`,
                    {
                      announcer: alias,
                      idleAgent: knownAlias,
                    },
                  );
                  resumeSessionWithBroadcast(
                    knownSessionId,
                    alias,
                    messageContent, // Just the message, no "[New agent joined]" prefix
                  ).catch((e) =>
                    log.error(LOG.TOOL, `Failed to resume on announcement`, {
                      error: String(e),
                    }),
                  );
                }
              }
            }

            return broadcastResult(
              alias,
              knownAgents,
              parallelAgents,
              undefined,
            );
          }

          // If first call but has reply_to, still mark as announced but process as normal reply
          if (isFirstCall) {
            announcedSessions.add(sessionId);
            log.info(
              LOG.TOOL,
              `First broadcast with reply_to - treating as normal reply`,
              {
                alias,
                reply_to: args.reply_to,
              },
            );
          }

          // Handle reply_to - mark message as handled and auto-wire recipient
          let handledMessage: HandledMessage | undefined;
          let autoRecipient: string | undefined;
          if (args.reply_to !== undefined) {
            const handled = markMessagesAsHandled(sessionId, [args.reply_to]);
            if (handled.length > 0) {
              handledMessage = handled[0];
              autoRecipient = handledMessage.from; // Auto-wire to sender

              // Warn if send_to was provided but will be ignored
              if (args.send_to && args.send_to !== autoRecipient) {
                log.warn(
                  LOG.TOOL,
                  `reply_to provided - ignoring send_to param`,
                  {
                    alias,
                    providedSendTo: args.send_to,
                    autoWiredRecipient: autoRecipient,
                  },
                );
              }

              log.info(LOG.TOOL, `Handled message via reply_to`, {
                alias,
                msgId: args.reply_to,
                autoRecipient,
              });
            }
          }

          const knownAgents = getKnownAliases(sessionId);
          let targetAliases: string[];

          if (autoRecipient) {
            // reply_to takes precedence - ALWAYS auto-wire to the sender, ignore send_to param
            targetAliases = [autoRecipient];
          } else if (!args.send_to) {
            // No target specified - send to all known agents
            targetAliases = knownAgents;
          } else {
            // Explicit recipient specified - single target only
            targetAliases = [args.send_to.trim()];
          }

          // If no agents to send to, just return info
          if (targetAliases.length === 0) {
            log.info(LOG.TOOL, `No recipients, returning agent info`, {
              alias,
            });
            return broadcastResult(alias, [], parallelAgents, handledMessage);
          }

          // DORMANT: parent alias feature
          const parentId = await getParentId(client, sessionId);

          const recipientSessions: string[] = [];
          const validTargets: string[] = [];
          for (const targetAlias of targetAliases) {
            const recipientSessionId = resolveAlias(targetAlias, parentId);
            if (!recipientSessionId) {
              log.warn(LOG.TOOL, `broadcast unknown recipient`, {
                alias,
                to: targetAlias,
              });
              return broadcastUnknownRecipient(targetAlias, knownAgents);
            }
            if (recipientSessionId === sessionId) {
              log.warn(LOG.TOOL, `Skipping self-message`, {
                alias,
                targetAlias,
              });
              if (targetAliases.length === 1) {
                return BROADCAST_SELF_MESSAGE;
              }
              continue;
            }
            recipientSessions.push(recipientSessionId);
            validTargets.push(targetAlias);
          }

          if (recipientSessions.length === 0) {
            log.info(LOG.TOOL, `No valid recipients after filtering`, {
              alias,
            });
            return broadcastResult(alias, [], parallelAgents, handledMessage);
          }

          // DORMANT: parent alias feature
          // Check if we're broadcasting to parent
          const isTargetingParent =
            parentId && recipientSessions.includes(parentId);

          // Send messages to all recipients
          // Check if recipient is idle and resume if so
          const resumedSessions: string[] = [];

          // Debug: log current session states
          log.debug(LOG.TOOL, `Broadcast checking session states`, {
            alias,
            recipientCount: recipientSessions.length,
            sessionStatesSize: sessionStates.size,
            trackedSessions: Array.from(sessionStates.keys()),
          });

          for (let i = 0; i < recipientSessions.length; i++) {
            const recipientSessionId = recipientSessions[i];
            const recipientState = sessionStates.get(recipientSessionId);

            log.debug(LOG.TOOL, `Checking recipient state`, {
              recipientSessionId,
              recipientAlias: validTargets[i],
              hasState: !!recipientState,
              status: recipientState?.status,
            });

            // Always store the message in inbox first
            sendMessage(alias, recipientSessionId, messageContent);

            // If recipient is idle, also resume the session
            if (recipientState?.status === "idle") {
              const resumed = await resumeSessionWithBroadcast(
                recipientSessionId,
                alias,
                messageContent,
              );
              if (resumed) {
                resumedSessions.push(validTargets[i]);
              }
            }
          }

          if (resumedSessions.length > 0) {
            log.info(LOG.TOOL, `Resumed idle sessions via broadcast`, {
              alias,
              resumedSessions,
            });
          }

          // Notify parent session if targeted (DORMANT)
          if (isTargetingParent) {
            log.info(
              LOG.MESSAGE,
              `Broadcasting to parent session, calling notify_once`,
              { sessionId, parentId },
            );
            try {
              const internalClient = (
                client as unknown as { _client?: InternalClient }
              )._client;
              if (internalClient?.post) {
                await internalClient.post({
                  url: `/session/${parentId}/notify_once`,
                  body: {
                    text: `[IAM] Message from ${alias}: ${args.message}`,
                  },
                });
                log.info(LOG.MESSAGE, `Parent session notified successfully`, {
                  parentId,
                });
              }
            } catch (e) {
              log.warn(LOG.MESSAGE, `Failed to notify parent session`, {
                parentId,
                error: String(e),
              });
            }
          }

          return broadcastResult(
            alias,
            validTargets,
            parallelAgents,
            handledMessage,
          );
        },
      }),

      spawn: tool({
        description: SPAWN_DESCRIPTION,
        args: {
          prompt: tool.schema
            .string()
            .describe("The task for the new agent to perform"),
          description: tool.schema
            .string()
            .optional()
            .describe("Short description of the task (3-5 words)"),
        },
        async execute(args, context: ToolContext) {
          const sessionId = context.sessionID;

          if (!args.prompt) {
            log.warn(LOG.TOOL, `spawn missing 'prompt'`, { sessionId });
            return SPAWN_MISSING_PROMPT;
          }

          // Get parent session ID - spawned agent will be a sibling (child of parent)
          const parentId = await getParentId(client, sessionId);
          if (!parentId) {
            log.warn(LOG.TOOL, `spawn called from non-child session`, {
              sessionId,
            });
            return SPAWN_NOT_CHILD_SESSION;
          }

          const callerAlias = getAlias(sessionId);
          const description = args.description || args.prompt.substring(0, 50);

          log.info(LOG.TOOL, `spawn called`, {
            callerAlias,
            parentId,
            descriptionLength: description.length,
            promptLength: args.prompt.length,
          });

          try {
            // APPROACH: Create a sibling session and prompt it directly
            // This makes it run, though it won't appear as a "task" in parent UI
            // unless we also inject a synthetic task tool result

            // Step 1: Create a sibling session (child of the same parent as caller)
            const createResult = await client.session.create({
              body: {
                parentID: parentId,
                title: `${description} (spawned by ${callerAlias})`,
              },
            });

            const newSessionId = createResult.data?.id;
            if (!newSessionId) {
              log.error(LOG.TOOL, `spawn failed to create session`, {
                callerAlias,
              });
              return `Error: Failed to create session. No session ID returned.`;
            }

            // Pre-register the new session so it can immediately use broadcast
            registerSession(newSessionId);
            const newAlias = getAlias(newSessionId);

            log.info(LOG.TOOL, `spawn created session`, {
              callerAlias,
              newAlias,
              newSessionId,
              parentId,
            });

            // Step 2: Inject task part into parent session BEFORE starting
            // This makes the spawn visible in the TUI immediately as "running"
            const spawnInfo: SpawnInfo = {
              sessionId: newSessionId,
              alias: newAlias,
              description,
              prompt: args.prompt,
              timestamp: Date.now(),
              injected: false,
              parentSessionId: parentId,
            };

            // Track that the CALLER has a pending spawn
            // This allows us to keep the caller alive until the spawn completes
            let callerSpawns = callerPendingSpawns.get(sessionId);
            if (!callerSpawns) {
              callerSpawns = new Set();
              callerPendingSpawns.set(sessionId, callerSpawns);
            }
            callerSpawns.add(newSessionId);
            log.info(LOG.TOOL, `spawn tracked for caller`, {
              callerSessionId: sessionId,
              callerAlias,
              spawnedSessionId: newSessionId,
              totalPendingSpawns: callerSpawns.size,
            });

            // Try to inject immediately into parent's message history
            const injected = await injectTaskPartToParent(
              client,
              parentId,
              spawnInfo,
            );

            if (injected) {
              spawnInfo.injected = true;
              activeSpawns.set(newSessionId, spawnInfo);
              log.info(LOG.TOOL, `spawn task injected to parent TUI`, {
                parentId,
                newAlias,
                partId: spawnInfo.partId,
              });
            } else {
              // Store for completion tracking anyway
              activeSpawns.set(newSessionId, spawnInfo);
              log.info(LOG.TOOL, `spawn stored for completion injection`, {
                parentId,
                newAlias,
              });
            }

            // Step 3: Start the session WITHOUT blocking (fire-and-forget)
            // agentA can continue working while agentB runs in parallel.
            // When agentB completes, we pipe its output to agentA.
            log.info(LOG.TOOL, `spawn starting session (non-blocking)`, {
              newAlias,
              newSessionId,
            });

            // Fire and forget - don't await the prompt
            client.session
              .prompt({
                path: { id: newSessionId },
                body: {
                  parts: [{ type: "text", text: args.prompt }],
                },
              })
              .then(async (result) => {
                const resultAny = result as { data?: unknown; error?: unknown };
                if (resultAny.error) {
                  log.error(LOG.TOOL, `spawn prompt failed`, {
                    newAlias,
                    error: JSON.stringify(resultAny.error),
                  });
                } else {
                  log.info(LOG.TOOL, `spawn agent completed (async)`, {
                    newAlias,
                    newSessionId,
                  });
                }

                // Spawned session completed - handle completion:

                // 1. Fetch the output from spawned session
                const spawnOutput = await fetchSpawnOutput(
                  client,
                  newSessionId,
                  newAlias,
                );

                // 2. Mark session as idle in sessionStates (enables resume)
                sessionStates.set(newSessionId, {
                  sessionId: newSessionId,
                  alias: newAlias,
                  status: "idle",
                  lastActivity: Date.now(),
                });
                log.info(LOG.SESSION, `Spawned session marked idle`, {
                  newSessionId,
                  newAlias,
                });

                // 3. Mark the spawn as completed in the parent TUI
                const spawn = activeSpawns.get(newSessionId);
                if (spawn) {
                  await markSpawnCompleted(client, spawn, spawnOutput);
                }

                // 4. Remove from caller's pending spawns
                const callerSpawnsAfter = callerPendingSpawns.get(sessionId);
                if (callerSpawnsAfter) {
                  callerSpawnsAfter.delete(newSessionId);
                  log.info(LOG.TOOL, `spawn removed from caller pending`, {
                    callerSessionId: sessionId,
                    spawnedSessionId: newSessionId,
                    remainingSpawns: callerSpawnsAfter.size,
                  });
                  if (callerSpawnsAfter.size === 0) {
                    callerPendingSpawns.delete(sessionId);
                  }
                }

                // 5. Pipe the spawn output to the caller (agentA)
                // If caller is idle: resume with the output
                // If caller is active: send as broadcast message (will be injected via transform)
                const callerState = sessionStates.get(sessionId);
                const callerAlias = sessionToAlias.get(sessionId) || "caller";

                // Create a summary message with the spawn output
                const outputMessage = `[Spawn completed: ${newAlias}]\n${spawnOutput}`;

                if (callerState?.status === "idle") {
                  // Caller is idle - resume with the output
                  log.info(
                    LOG.TOOL,
                    `Piping spawn output to idle caller via resume`,
                    {
                      callerSessionId: sessionId,
                      callerAlias,
                      spawnAlias: newAlias,
                    },
                  );
                  resumeSessionWithBroadcast(
                    sessionId,
                    newAlias,
                    outputMessage,
                  ).catch((e) =>
                    log.error(
                      LOG.TOOL,
                      `Failed to pipe spawn output to caller`,
                      {
                        error: String(e),
                      },
                    ),
                  );
                } else {
                  // Caller is still active - send as broadcast message
                  // It will be picked up by the synthetic injection on next LLM call
                  log.info(
                    LOG.TOOL,
                    `Piping spawn output to active caller via message`,
                    {
                      callerSessionId: sessionId,
                      callerAlias,
                      spawnAlias: newAlias,
                    },
                  );
                  sendMessage(newAlias, sessionId, outputMessage);
                }

                // 6. Check for unread messages and resume spawned session if needed
                const unreadMessages = getMessagesNeedingResume(newSessionId);
                if (unreadMessages.length > 0) {
                  log.info(
                    LOG.SESSION,
                    `Spawned session has unread messages, resuming`,
                    {
                      newSessionId,
                      newAlias,
                      unreadCount: unreadMessages.length,
                    },
                  );
                  const firstUnread = unreadMessages[0];
                  markMessagesAsPresented(newSessionId, [firstUnread.msgIndex]);
                  resumeSessionWithBroadcast(
                    newSessionId,
                    firstUnread.from,
                    firstUnread.body,
                  ).catch((e) =>
                    log.error(LOG.SESSION, `Failed to resume spawned session`, {
                      error: String(e),
                    }),
                  );
                }
              })
              .catch((err: unknown) => {
                log.error(LOG.TOOL, `spawn prompt error`, {
                  newAlias,
                  error: String(err),
                });
              });

            // Return immediately - caller can continue working
            return spawnResult(newAlias, newSessionId, description);
          } catch (e) {
            log.error(LOG.TOOL, `spawn failed`, {
              callerAlias,
              error: String(e),
            });
            return `Error: Failed to spawn agent: ${String(e)}`;
          }
        },
      }),
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
          `Session has no parentID (main session), skipping IAM`,
          { sessionId },
        );
        return;
      }

      // Register child session early - before agent even calls broadcast
      registerSession(sessionId);

      // Check if there's a pending task description for this session's parent
      const parentId = await getParentId(client, sessionId);
      if (parentId) {
        const pending = pendingTaskDescriptions.get(parentId);
        if (pending && pending.length > 0) {
          // Use the first pending description for this child session
          const description = pending.shift()!;
          setDescription(sessionId, description);
          // Don't mark as announced - agent should still see the hint to broadcast

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

      // Inject IAM instructions
      output.system.push(SYSTEM_PROMPT);
      log.info(
        LOG.INJECT,
        `Registered session and injected IAM system prompt`,
        {
          sessionId,
          alias: getAlias(sessionId),
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
          `No user message found in transform, skipping IAM injection`,
        );
        return;
      }

      const sessionId = lastUserMsg.info.sessionID;

      // Check for pending spawns that need to be injected into this session
      // This works for BOTH main sessions and child sessions
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

      // Only inject IAM broadcast/inbox for child sessions (those with parentID)
      if (!(await isChildSession(client, sessionId))) {
        log.debug(LOG.INJECT, `Skipping IAM inbox for main session`, {
          sessionId,
          injectedSpawns: uninjectedSpawns.length,
        });
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
      // "Presented" means the agent saw the message in their context
      // This is different from "handled" which means the agent explicitly used reply_to
      // We don't resume with presented messages (agent had a chance to see them)
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
