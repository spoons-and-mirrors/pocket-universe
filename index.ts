import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  BROADCAST_SELF_MESSAGE,
  broadcastUnknownRecipient,
  broadcastResult,
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
    }) => Promise<{ data?: { parentID?: string } }>; // DORMANT: parent alias feature
  };
}

/** Internal client interface (accessed via type assertion) */
interface InternalClient {
  post?: (params: { url: string; body: unknown }) => Promise<unknown>;
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

function getUnhandledMessages(sessionId: string): Message[] {
  return getInbox(sessionId).filter((m) => !m.handled);
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

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized");
  const client = ctx.client as OpenCodeSessionClient;

  return {
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
          for (const recipientSessionId of recipientSessions) {
            sendMessage(alias, recipientSessionId, messageContent);
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

      // Only inject for child sessions (those with parentID)
      if (!(await isChildSession(client, sessionId))) {
        log.debug(LOG.INJECT, `Skipping messages.transform for main session`, {
          sessionId,
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

      // Push at the END of the messages array (recency bias)
      output.messages.push(inboxMsg as unknown as UserMessage);
    },

    // Add broadcast to subagent_tools
    "experimental.config.transform": async (
      _input: unknown,
      output: ConfigTransformOutput,
    ) => {
      const experimental = output.experimental ?? {};
      const existingSubagentTools = experimental.subagent_tools ?? [];
      output.experimental = {
        ...experimental,
        subagent_tools: [...existingSubagentTools, "broadcast"],
      };
      log.info(LOG.HOOK, `Added 'broadcast' to experimental.subagent_tools`);
    },
  };
};

export default plugin;
