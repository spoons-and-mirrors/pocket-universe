import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  TOOL_DESCRIPTION,
  ARG_DESCRIPTIONS,
  readResult,
  BROADCAST_MISSING_MESSAGE,
  announceResult,
  broadcastUnknownRecipient,
  broadcastResult,
  unknownAction,
  SYSTEM_PROMPT,
  urgentNotification,
} from "./prompt"
import { log, LOG } from "./logger"

// ============================================================================
// In-memory message store
// ============================================================================

interface Message {
  id: string
  from: string
  to: string
  body: string
  timestamp: number
  read: boolean
}

// Messages indexed by recipient session ID
const inboxes = new Map<string, Message[]>()

// Track ALL active sessions (simpler approach - register on first iam use)
const activeSessions = new Set<string>()

// Alias mappings: sessionId <-> alias (e.g., "agentA", "agentB")
const sessionToAlias = new Map<string, string>()
const aliasToSession = new Map<string, string>()
const agentDescriptions = new Map<string, string>() // alias -> description
let nextAgentIndex = 0

// Track which sessions have received IAM instructions
const instructedSessions = new Set<string>()

// Cache for parentID lookups
const sessionParentCache = new Map<string, string | null>()

function getNextAlias(): string {
  const letter = String.fromCharCode(65 + (nextAgentIndex % 26)) // A-Z
  const suffix = nextAgentIndex >= 26 ? Math.floor(nextAgentIndex / 26).toString() : ""
  nextAgentIndex++
  return `agent${letter}${suffix}`
}

function getAlias(sessionId: string): string {
  return sessionToAlias.get(sessionId) || sessionId
}

function setDescription(sessionId: string, description: string): void {
  const alias = getAlias(sessionId)
  agentDescriptions.set(alias, description)
  log.info(LOG.SESSION, `Agent announced`, { alias, description })
}

function getDescription(alias: string): string | undefined {
  return agentDescriptions.get(alias)
}

function hasAnnounced(sessionId: string): boolean {
  const alias = getAlias(sessionId)
  return agentDescriptions.has(alias)
}

function resolveAlias(aliasOrSessionId: string, parentId?: string | null): string | undefined {
  // Handle special "parent" alias
  if (aliasOrSessionId === "parent" && parentId) {
    return parentId
  }
  // Try alias first, then assume it's a session ID
  return aliasToSession.get(aliasOrSessionId) || 
    (activeSessions.has(aliasOrSessionId) ? aliasOrSessionId : undefined)
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
  
  getInbox(to).push(message)
  log.info(LOG.MESSAGE, `Message sent`, { id: message.id, from, to, bodyLength: body.length })
  return message
}

function getUnreadMessages(sessionId: string): Message[] {
  return getInbox(sessionId).filter(m => !m.read)
}

function getAllMessages(sessionId: string): Message[] {
  return getInbox(sessionId)
}

function markAllRead(sessionId: string): void {
  const iam = getInbox(sessionId)
  const unreadCount = iam.filter(m => !m.read).length
  for (const msg of iam) {
    msg.read = true
  }
  log.info(LOG.MESSAGE, `Marked all read`, { sessionId, count: unreadCount })
}

function getKnownAgents(sessionId: string): string[] {
  // Return aliases of all active sessions except self
  const agents: string[] = []
  for (const id of activeSessions) {
    if (id !== sessionId) {
      agents.push(getAlias(id))
    }
  }
  return agents
}

function getParallelAgents(sessionId: string) {
  return getKnownAgents(sessionId).map(alias => ({
    alias,
    description: getDescription(alias)
  }))
}

function registerSession(sessionId: string): void {
  if (!activeSessions.has(sessionId)) {
    activeSessions.add(sessionId)
    const alias = getNextAlias()
    sessionToAlias.set(sessionId, alias)
    aliasToSession.set(alias, sessionId)
    log.info(LOG.SESSION, `Session registered`, { sessionId, alias, totalSessions: activeSessions.size })
  }
}

// ============================================================================
// Session utils
// ============================================================================

async function getParentId(client: any, sessionId: string): Promise<string | null> {
  // Check cache first
  if (sessionParentCache.has(sessionId)) {
    return sessionParentCache.get(sessionId)!
  }
  
  try {
    const response = await client.session.get({ path: { id: sessionId } })
    const parentId = response.data?.parentID || null
    sessionParentCache.set(sessionId, parentId)
    log.debug(LOG.SESSION, `Looked up parentID`, { sessionId, parentId })
    return parentId
  } catch (e) {
    log.warn(LOG.SESSION, `Failed to get session info`, { sessionId, error: String(e) })
    sessionParentCache.set(sessionId, null)
    return null
  }
}

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized")
  const client = ctx.client
  
  return {
    tool: {
      iam: tool({
        description: TOOL_DESCRIPTION,
        args: {
          action: tool.schema.enum(["read", "broadcast", "announce"]).describe(
            ARG_DESCRIPTIONS.action
          ),
          to: tool.schema.string().optional().describe(
            ARG_DESCRIPTIONS.to
          ),
          message: tool.schema.string().optional().describe(
            ARG_DESCRIPTIONS.message
          ),
        },
        async execute(args, context) {
          const sessionId = context.sessionID
          
          // Register this session on first iam use
          registerSession(sessionId)
          
          const alias = getAlias(sessionId)
          const announced = hasAnnounced(sessionId)
          
          log.debug(LOG.TOOL, `iam action: ${args.action}`, { sessionId, alias, args })
          
          switch (args.action) {
            case "read": {
              const messages = getAllMessages(sessionId)
              const unreadCount = messages.filter(m => !m.read).length
              log.debug(LOG.TOOL, `read inbox`, { alias, total: messages.length, unread: unreadCount })
              
              // Mark all as read
              markAllRead(sessionId)
              
              return readResult(alias, messages, unreadCount, announced)
            }
            
            case "broadcast": {
              if (!args.message) {
                log.warn(LOG.TOOL, `broadcast missing 'message'`, { alias })
                return BROADCAST_MISSING_MESSAGE
              }
              
              const knownAgents = getKnownAgents(sessionId)
              let targetAliases: string[]
              
              // Determine recipients
              if (!args.to || args.to.toLowerCase() === "all") {
                // Broadcast to all
                targetAliases = knownAgents
              } else {
                // Parse comma-separated list
                targetAliases = args.to.split(",").map(s => s.trim()).filter(Boolean)
              }
              
              if (targetAliases.length === 0) {
                return `No agents to broadcast to. Use action="announce" to see parallel agents.`
              }
              
              // Get parent ID early so we can resolve "parent" alias
              const parentId = await getParentId(client, sessionId)
              
              // Resolve all aliases and validate
              const recipientSessions: string[] = []
              for (const targetAlias of targetAliases) {
                const recipientSessionId = resolveAlias(targetAlias, parentId)
                if (!recipientSessionId) {
                  log.warn(LOG.TOOL, `broadcast unknown recipient`, { alias, to: targetAlias })
                  return broadcastUnknownRecipient(targetAlias, knownAgents)
                }
                recipientSessions.push(recipientSessionId)
              }
              
              // Send to all recipients
              let messageId = ""
              for (const recipientSessionId of recipientSessions) {
                const msg = sendMessage(alias, recipientSessionId, args.message)
                messageId = msg.id // Use last message ID
              }
              
              // Check if we're broadcasting to our parent session - if so, wake it up
              if (parentId && recipientSessions.includes(parentId)) {
                log.info(LOG.MESSAGE, `Broadcasting to parent session, calling notify_once`, { sessionId, parentId })
                try {
                  // Call notify_once to wake parent for one model iteration
                  // Access the internal SDK client to make a raw POST request
                  const internalClient = (client as any)._client
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
                  log.warn(LOG.MESSAGE, `Failed to notify parent session`, { parentId, error: String(e) })
                }
              }
              
              return broadcastResult(targetAliases, messageId)
            }
            
            case "announce": {
              if (!args.message) {
                log.warn(LOG.TOOL, `announce missing 'message'`, { alias })
                return `Error: 'message' parameter is required for action="announce". Describe what you're working on.`
              }
              
              setDescription(sessionId, args.message)
              const parallelAgents = getParallelAgents(sessionId)
              
              return announceResult(alias, parallelAgents)
            }
            
            default:
              return unknownAction(args.action)
          }
        },
      }),
    },
    
    // Register subagents when task tool completes
    "tool.execute.after": async (input, output) => {
      log.debug(LOG.HOOK, `tool.execute.after fired`, { tool: input.tool, sessionID: input.sessionID, hasMetadata: !!output.metadata })
      
      if (input.tool === "task") {
        log.debug(LOG.HOOK, `task metadata`, { metadata: output.metadata, output: output.output?.substring?.(0, 200) })
        
        const newSessionId = (output.metadata?.sessionId || output.metadata?.session_id) as string | undefined
        if (newSessionId) {
          log.info(LOG.HOOK, `task completed, registering session`, { newSessionId })
          registerSession(newSessionId)
        } else {
          log.warn(LOG.HOOK, `task completed but no session_id in metadata`)
        }
      }
    },
    
    // Inject IAM instructions into system prompt for child sessions only
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = (input as any).sessionID as string | undefined
      if (!sessionId) {
        log.debug(LOG.INJECT, `No sessionID in system.transform input, skipping`)
        return
      }
      
      // Check if this is a child session (has parentID)
      const parentId = await getParentId(client, sessionId)
      if (!parentId) {
        log.debug(LOG.INJECT, `Skipping system prompt injection for main session (no parentID)`, { sessionId })
        return
      }
      
      // This is a child session - inject IAM instructions
      output.system.push(SYSTEM_PROMPT)
      log.info(LOG.INJECT, `Injected IAM system prompt for child session`, { sessionId, parentId })
    },
    
    // Inject urgent notifications for unread messages
    "experimental.chat.messages.transform": async (_input, output) => {
      const lastUserMsg = [...output.messages].reverse().find(m => m.info.role === "user")
      if (!lastUserMsg) return
      
      const sessionId = lastUserMsg.info.sessionID
      const unread = getUnreadMessages(sessionId)
      
      if (unread.length === 0) return
      
      log.info(LOG.INJECT, `Injecting urgent notification`, { sessionId, unreadCount: unread.length })
      
      // Create synthetic user message with notification
      const syntheticMessage = {
        info: {
          id: "msg_iam_" + Date.now(),
          sessionID: sessionId,
          role: "user" as const,
          time: { created: Date.now() },
          agent: (lastUserMsg.info as any).agent || "code",
          model: (lastUserMsg.info as any).model,
        },
        parts: [
          {
            id: "prt_iam_" + Date.now(),
            sessionID: sessionId,
            messageID: "msg_iam_" + Date.now(),
            type: "text" as const,
            text: urgentNotification(unread.length),
          }
        ]
      }
      
      output.messages.push(syntheticMessage as any)
    },
    
    // Add iam to subagent_tools so it's only available to subagents
    config: async (opencodeConfig) => {
      const experimental = opencodeConfig.experimental as any ?? {}
      const existingSubagentTools = experimental.subagent_tools ?? []
      opencodeConfig.experimental = {
        ...experimental,
        subagent_tools: [...existingSubagentTools, "iam"],
      } as typeof opencodeConfig.experimental
      log.info(LOG.HOOK, `Added 'iam' to experimental.subagent_tools`)
    },
  }
}

export default plugin
