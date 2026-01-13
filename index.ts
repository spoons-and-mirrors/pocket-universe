import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  BROADCAST_SELF_MESSAGE,
  broadcastMessageTooLong,
  broadcastUnknownRecipient,
  broadcastResult,
  SYSTEM_PROMPT,
  type ParallelAgent,
} from "./prompt"
import { log, LOG } from "./logger"

// ============================================================================
// Constants
// ============================================================================

const CHAR_CODE_A = 65 // ASCII code for 'A'
const ALPHABET_SIZE = 26
const MAX_DESCRIPTION_LENGTH = 100
const MESSAGE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MAX_INBOX_SIZE = 100 // Max messages per inbox
const PARENT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000 // Run cleanup every minute
const DEFAULT_MODEL_ID = "gpt-4o-2024-08-06"
const DEFAULT_PROVIDER_ID = "openai"
const MAX_MESSAGE_LENGTH = 10000 // Prevent excessively long messages

// ============================================================================
// Types
// ============================================================================

interface Message {
  id: string
  from: string
  to: string
  body: string
  timestamp: number
  read: boolean
}

interface CachedParentId {
  value: string | null
  cachedAt: number
}

/** Minimal interface for OpenCode SDK client session API */
interface OpenCodeSessionClient {
  session: {
    get: (params: { path: { id: string } }) => Promise<{ data?: { parentID?: string } }>
  }
}

/** Internal client interface (accessed via type assertion) */
interface InternalClient {
  post?: (params: { url: string; body: unknown }) => Promise<unknown>
}

/** Message info from OpenCode SDK */
interface MessageInfo {
  id: string
  sessionID: string
  role: string
  agent?: string
  model?: {
    modelID?: string
    providerID?: string
  }
  variant?: unknown
}

/** User message structure from OpenCode SDK */
interface UserMessage {
  info: MessageInfo
  parts: unknown[]
}

/** Tool execution context */
interface ToolContext {
  sessionID: string
}

/** Hook input for tool.execute.after */
interface ToolExecuteInput {
  tool: string
  sessionID: string
}

/** Hook output for tool.execute.after */
interface ToolExecuteOutput {
  metadata?: {
    sessionId?: string
    session_id?: string
  }
  output?: string
}

/** Hook input for system.transform */
interface SystemTransformInput {
  sessionID?: string
}

/** Hook output for system.transform */
interface SystemTransformOutput {
  system: string[]
}

/** Hook output for messages.transform */
interface MessagesTransformOutput {
  messages: UserMessage[]
}

/** Hook output for config.transform */
interface ConfigTransformOutput {
  experimental?: {
    subagent_tools?: string[]
    [key: string]: unknown
  }
}

// ============================================================================
// In-memory message store
// ============================================================================

// Messages indexed by recipient session ID
const inboxes = new Map<string, Message[]>()

// Track ALL active sessions (simpler approach - register on first iam use)
const activeSessions = new Set<string>()

// Alias mappings: sessionId <-> alias (e.g., "agentA", "agentB")
const sessionToAlias = new Map<string, string>()
const aliasToSession = new Map<string, string>()
const agentDescriptions = new Map<string, string>() // alias -> description

// Atomic alias counter with registration lock
let nextAgentIndex = 0
const registeringSessionsLock = new Set<string>() // Prevent race conditions

// Cache for parentID lookups with expiry
const sessionParentCache = new Map<string, CachedParentId>()

// ============================================================================
// Cleanup - prevent memory leaks
// ============================================================================

function cleanupExpiredMessages(): void {
  const now = Date.now()
  let totalRemoved = 0

  for (const [sessionId, messages] of inboxes) {
    const before = messages.length

    // Remove expired messages (keep unread ones longer)
    const filtered = messages.filter((m) => {
      if (m.read) {
        return now - m.timestamp < MESSAGE_TTL_MS
      }
      // Keep unread messages 3x longer
      return now - m.timestamp < MESSAGE_TTL_MS * 3
    })

    // Also trim to max size if needed
    if (filtered.length > MAX_INBOX_SIZE) {
      // Keep newest messages, remove oldest read ones first
      const unread = filtered.filter((m) => !m.read)
      const read = filtered.filter((m) => m.read)
      read.sort((a, b) => b.timestamp - a.timestamp)
      const kept = [...unread, ...read.slice(0, MAX_INBOX_SIZE - unread.length)]
      inboxes.set(sessionId, kept)
      totalRemoved += before - kept.length
    } else {
      inboxes.set(sessionId, filtered)
      totalRemoved += before - filtered.length
    }

    // Remove empty inboxes
    if (inboxes.get(sessionId)!.length === 0) {
      inboxes.delete(sessionId)
    }
  }

  // Cleanup expired parent cache entries
  for (const [sessionId, cached] of sessionParentCache) {
    if (now - cached.cachedAt > PARENT_CACHE_TTL_MS) {
      sessionParentCache.delete(sessionId)
    }
  }

  if (totalRemoved > 0) {
    log.debug(LOG.MESSAGE, `Cleanup removed ${totalRemoved} expired messages`)
  }
}

// Start cleanup interval
setInterval(cleanupExpiredMessages, CLEANUP_INTERVAL_MS)

// ============================================================================
// Alias management
// ============================================================================

function getNextAlias(): string {
  // Atomically get and increment the counter
  const index = nextAgentIndex
  nextAgentIndex++

  const letter = String.fromCharCode(CHAR_CODE_A + (index % ALPHABET_SIZE))
  const suffix = index >= ALPHABET_SIZE ? Math.floor(index / ALPHABET_SIZE).toString() : ""
  return `agent${letter}${suffix}`
}

function getAlias(sessionId: string): string {
  return sessionToAlias.get(sessionId) || sessionId
}

function setDescription(sessionId: string, description: string): void {
  const alias = getAlias(sessionId)
  const truncated = description.substring(0, MAX_DESCRIPTION_LENGTH)
  agentDescriptions.set(alias, truncated)
  log.info(LOG.SESSION, `Agent announced`, { alias, description: truncated })
}

function getDescription(alias: string): string | undefined {
  return agentDescriptions.get(alias)
}

function resolveAlias(aliasOrSessionId: string, parentId?: string | null): string | undefined {
  // Handle special "parent" alias
  if (aliasOrSessionId === "parent" && parentId) {
    return parentId
  }
  // Try alias first, then assume it's a session ID
  return (
    aliasToSession.get(aliasOrSessionId) ||
    (activeSessions.has(aliasOrSessionId) ? aliasOrSessionId : undefined)
  )
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

function getInbox(sessionId: string): Message[] {
  if (!inboxes.has(sessionId)) {
    inboxes.set(sessionId, [])
  }
  return inboxes.get(sessionId)!
}

// ============================================================================
// Core messaging functions
// ============================================================================

function sendMessage(from: string, to: string, body: string): Message {
  const message: Message = {
    id: generateId(),
    from,
    to,
    body,
    timestamp: Date.now(),
    read: false,
  }

  const inbox = getInbox(to)

  // Enforce max inbox size
  if (inbox.length >= MAX_INBOX_SIZE) {
    // Remove oldest read message, or oldest message if all unread
    const readIndex = inbox.findIndex((m) => m.read)
    if (readIndex !== -1) {
      inbox.splice(readIndex, 1)
    } else {
      inbox.shift() // Remove oldest
    }
    log.warn(LOG.MESSAGE, `Inbox full, removed oldest message`, { to })
  }

  inbox.push(message)
  log.info(LOG.MESSAGE, `Message sent`, { id: message.id, from, to, bodyLength: body.length })
  return message
}

function getUnreadMessages(sessionId: string): Message[] {
  return getInbox(sessionId).filter((m) => !m.read)
}

function getKnownAliases(sessionId: string): string[] {
  // Return aliases of all active sessions except self
  const selfAlias = sessionToAlias.get(sessionId)
  const agents: string[] = []
  for (const alias of aliasToSession.keys()) {
    if (alias !== selfAlias) {
      agents.push(alias)
    }
  }
  return agents
}

function getParallelAgents(sessionId: string): ParallelAgent[] {
  // Directly iterate aliases without calling getKnownAliases again
  const selfAlias = sessionToAlias.get(sessionId)
  const agents: ParallelAgent[] = []
  for (const alias of aliasToSession.keys()) {
    if (alias !== selfAlias) {
      agents.push({
        alias,
        description: getDescription(alias),
      })
    }
  }
  return agents
}

function registerSession(sessionId: string): void {
  // Check if already registered
  if (activeSessions.has(sessionId)) {
    return
  }

  // Acquire lock to prevent race condition
  if (registeringSessionsLock.has(sessionId)) {
    // Another registration in progress, wait and return
    // In practice this is a sync check so we just return
    return
  }

  registeringSessionsLock.add(sessionId)

  try {
    // Double-check after acquiring lock
    if (!activeSessions.has(sessionId)) {
      activeSessions.add(sessionId)
      const alias = getNextAlias()
      sessionToAlias.set(sessionId, alias)
      aliasToSession.set(alias, sessionId)
      log.info(LOG.SESSION, `Session registered`, {
        sessionId,
        alias,
        totalSessions: activeSessions.size,
      })
    }
  } finally {
    registeringSessionsLock.delete(sessionId)
  }
}

// ============================================================================
// Session utils
// ============================================================================

async function getParentId(client: OpenCodeSessionClient, sessionId: string): Promise<string | null> {
  const now = Date.now()

  // Check cache first (with expiry)
  const cached = sessionParentCache.get(sessionId)
  if (cached && now - cached.cachedAt < PARENT_CACHE_TTL_MS) {
    return cached.value
  }

  try {
    const response = await client.session.get({ path: { id: sessionId } })
    const parentId = response.data?.parentID || null
    sessionParentCache.set(sessionId, { value: parentId, cachedAt: now })
    log.debug(LOG.SESSION, `Looked up parentID`, { sessionId, parentId })
    return parentId
  } catch (e) {
    log.warn(LOG.SESSION, `Failed to get session info`, { sessionId, error: String(e) })
    // Cache failure for shorter duration (1 minute) to allow retry
    sessionParentCache.set(sessionId, { value: null, cachedAt: now - PARENT_CACHE_TTL_MS + 60000 })
    return null
  }
}

// ============================================================================
// Helper to create assistant message with tool part
// ============================================================================

interface AssistantMessage {
  info: {
    id: string
    sessionID: string
    role: string
    agent: string
    parentID: string
    modelID: string
    providerID: string
    mode: string
    path: { cwd: string; root: string }
    time: { created: number; completed: number }
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    variant?: unknown
  }
  parts: Array<{
    id: string
    sessionID: string
    messageID: string
    type: string
    callID: string
    tool: string
    state: {
      status: string
      input: { from: string; messageId: string; timestamp: number }
      output: string
      title: string
      metadata: { iam_sender: string; iam_message_id: string; iam_timestamp: number }
      time: { start: number; end: number }
    }
  }>
}

function createAssistantMessageWithToolPart(
  sessionId: string,
  senderAlias: string,
  messageBody: string,
  messageId: string,
  timestamp: number,
  baseUserMessage: UserMessage
): AssistantMessage {
  const now = Date.now()
  const userInfo = baseUserMessage.info

  const assistantMessageId = `msg_iam_${now}_${messageId}`
  const partId = `prt_iam_${now}_${messageId}`
  const callId = `call_iam_${now}_${messageId}`

  log.debug(LOG.MESSAGE, `Creating assistant message with tool part`, {
    sessionId,
    senderAlias,
    messageId: assistantMessageId,
    partId,
    callId,
  })

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
      path: {
        cwd: "/",
        root: "/",
      },
      time: { created: now, completed: now },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: partId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "tool",
        callID: callId,
        tool: "iam_message",
        state: {
          status: "completed",
          input: {
            from: senderAlias,
            messageId: messageId,
            timestamp: timestamp,
          },
          output: `📨 INCOMING MESSAGE FROM ${senderAlias.toUpperCase()} 📨

${messageBody}

---
Reply using: broadcast(recipient="${senderAlias}", message="your response")`,
          title: `📨 Message from ${senderAlias}`,
          metadata: {
            iam_sender: senderAlias,
            iam_message_id: messageId,
            iam_timestamp: timestamp,
          },
          time: { start: now, end: now },
        },
      },
    ],
  }

  // Add variant if present
  if (userInfo.variant !== undefined) {
    result.info.variant = userInfo.variant
  }

  return result
}

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized")
  const client = ctx.client as OpenCodeSessionClient

  return {
    tool: {
      broadcast: tool({
        description: BROADCAST_DESCRIPTION,
        args: {
          recipient: tool.schema
            .string()
            .optional()
            .describe("Target agent(s), comma-separated. Omit to send to all."),
          message: tool.schema.string().describe("Your message"),
        },
        async execute(args, context: ToolContext) {
          const sessionId = context.sessionID
          const isFirstCall = !activeSessions.has(sessionId)
          registerSession(sessionId)

          const alias = getAlias(sessionId)

          if (!args.message) {
            log.warn(LOG.TOOL, `broadcast missing 'message'`, { alias })
            return BROADCAST_MISSING_MESSAGE
          }

          // Validate message length
          if (args.message.length > MAX_MESSAGE_LENGTH) {
            log.warn(LOG.TOOL, `broadcast message too long`, { alias, length: args.message.length })
            return broadcastMessageTooLong(args.message.length, MAX_MESSAGE_LENGTH)
          }

          // Use message as status description (only on first call)
          if (isFirstCall) {
            setDescription(sessionId, args.message)
          }

          log.debug(LOG.TOOL, `broadcast called`, {
            sessionId,
            alias,
            recipient: args.recipient,
            messageLength: args.message.length,
            isFirstCall,
          })

          const knownAgents = getKnownAliases(sessionId)
          const parallelAgents = getParallelAgents(sessionId)
          let targetAliases: string[]

          if (!args.recipient) {
            // No target specified - send to all known agents
            targetAliases = knownAgents
          } else {
            targetAliases = args.recipient
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          }

          // If no agents to send to, just return registration info
          if (targetAliases.length === 0) {
            log.info(LOG.TOOL, `No recipients, returning agent info`, { alias })
            return broadcastResult(alias, [], "", parallelAgents, isFirstCall)
          }

          const parentId = await getParentId(client, sessionId)

          const recipientSessions: string[] = []
          const validTargets: string[] = []
          for (const targetAlias of targetAliases) {
            const recipientSessionId = resolveAlias(targetAlias, parentId)
            if (!recipientSessionId) {
              log.warn(LOG.TOOL, `broadcast unknown recipient`, { alias, to: targetAlias })
              return broadcastUnknownRecipient(targetAlias, knownAgents)
            }
          // Skip sending to yourself - with user feedback
            if (recipientSessionId === sessionId) {
              log.warn(LOG.TOOL, `Skipping self-message`, { alias, targetAlias })
              // If ONLY targeting self, return explicit error
              if (targetAliases.length === 1) {
                return BROADCAST_SELF_MESSAGE
              }
              continue
            }
            recipientSessions.push(recipientSessionId)
            validTargets.push(targetAlias)
          }

          if (recipientSessions.length === 0) {
            log.info(LOG.TOOL, `No valid recipients after filtering`, { alias })
            return broadcastResult(alias, [], "", parallelAgents, isFirstCall)
          }

          // Check if we're broadcasting to parent (to send notification)
          const isTargetingParent = parentId && recipientSessions.includes(parentId)

          const messageIds: string[] = []
          for (const recipientSessionId of recipientSessions) {
            const msg = sendMessage(alias, recipientSessionId, args.message)
            messageIds.push(msg.id)

            log.info(LOG.MESSAGE, `Message queued for recipient`, {
              senderAlias: alias,
              senderSessionId: sessionId,
              recipientSessionId,
              messageId: msg.id,
              messageLength: args.message.length,
              isParent: recipientSessionId === parentId,
            })
          }

          // Only notify parent session (not siblings)
          if (isTargetingParent) {
            log.info(LOG.MESSAGE, `Broadcasting to parent session, calling notify_once`, {
              sessionId,
              parentId,
            })
            try {
              const internalClient = (client as unknown as { _client?: InternalClient })._client
              if (internalClient?.post) {
                await internalClient.post({
                  url: `/session/${parentId}/notify_once`,
                  body: { text: `[IAM] Message from ${alias}: ${args.message}` },
                })
                log.info(LOG.MESSAGE, `Parent session notified successfully`, { parentId })
              } else {
                log.warn(LOG.MESSAGE, `Could not access SDK client for notify_once`, { parentId })
              }
            } catch (e) {
              log.warn(LOG.MESSAGE, `Failed to notify parent session`, {
                parentId,
                error: String(e),
              })
            }
          }

          // Return first message ID for backward compatibility
          const displayMessageId = messageIds.length > 0 ? messageIds[0] : ""
          return broadcastResult(alias, validTargets, displayMessageId, parallelAgents, isFirstCall)
        },
      }),
    },

    // Register subagents when task tool completes
    "tool.execute.after": async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
      log.debug(LOG.HOOK, `tool.execute.after fired`, {
        tool: input.tool,
        sessionID: input.sessionID,
        hasMetadata: !!output.metadata,
      })

      if (input.tool === "task") {
        log.debug(LOG.HOOK, `task metadata`, {
          metadata: output.metadata,
          output: output.output?.substring?.(0, 200),
        })

        const newSessionId = (output.metadata?.sessionId || output.metadata?.session_id) as
          | string
          | undefined
        if (newSessionId) {
          log.info(LOG.HOOK, `task completed, registering session`, { newSessionId })
          registerSession(newSessionId)
        } else {
          log.warn(LOG.HOOK, `task completed but no session_id in metadata`)
        }
      }
    },

    // Inject IAM instructions into system prompt for child sessions only
    "experimental.chat.system.transform": async (
      input: SystemTransformInput,
      output: SystemTransformOutput
    ) => {
      const sessionId = input.sessionID
      if (!sessionId) {
        log.debug(LOG.INJECT, `No sessionID in system.transform input, skipping`)
        return
      }

      // Inject IAM instructions for all sessions
      output.system.push(SYSTEM_PROMPT)
      log.info(LOG.INJECT, `Injected IAM system prompt`, { sessionId })
    },

    // Inject assistant messages with tool parts for unread IAM messages
    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: MessagesTransformOutput
    ) => {
      const lastUserMsg = [...output.messages].reverse().find((m) => m.info.role === "user")
      if (!lastUserMsg) {
        log.debug(LOG.INJECT, `No user message found in transform, skipping IAM injection`)
        return
      }

      const sessionId = lastUserMsg.info.sessionID
      const unread = getUnreadMessages(sessionId)

      log.debug(LOG.INJECT, `Checking for unread messages in transform`, {
        sessionId,
        unreadCount: unread.length,
      })

      if (unread.length === 0) {
        return
      }

      log.info(LOG.INJECT, `Injecting ${unread.length} assistant message(s) with tool parts`, {
        sessionId,
        unreadCount: unread.length,
        messageIds: unread.map((m) => m.id),
      })

      // Inject one assistant message with tool part for each unread message
      for (const msg of unread) {
        const assistantMsg = createAssistantMessageWithToolPart(
          sessionId,
          msg.from,
          msg.body,
          msg.id,
          msg.timestamp,
          lastUserMsg
        )

        // Cast to allow pushing to messages array
        output.messages.push(assistantMsg as unknown as UserMessage)

        log.info(LOG.INJECT, `Injected assistant message with tool part`, {
          sessionId,
          senderAlias: msg.from,
          messageId: assistantMsg.info.id,
          partId: assistantMsg.parts[0].id,
        })

        // Mark as read after injection
        msg.read = true
      }

      log.info(LOG.INJECT, `Marked ${unread.length} messages as read after injection`, {
        sessionId,
      })
    },

    // Add broadcast to subagent_tools
    "experimental.config.transform": async (_input: unknown, output: ConfigTransformOutput) => {
      const experimental = output.experimental ?? {}
      const existingSubagentTools = experimental.subagent_tools ?? []
      output.experimental = {
        ...experimental,
        subagent_tools: [...existingSubagentTools, "broadcast"],
      }
      log.info(LOG.HOOK, `Added 'broadcast' to experimental.subagent_tools`)
    },
  }
}

export default plugin
