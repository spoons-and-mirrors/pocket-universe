import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  TOOL_DESCRIPTION,
  ARG_DESCRIPTIONS,
  SESSIONS_EMPTY,
  sessionsResult,
  READ_EMPTY,
  readResult,
  WRITE_MISSING_TO,
  WRITE_MISSING_MESSAGE,
  ANNOUNCE_MISSING_MESSAGE,
  announceResult,
  writeUnknownRecipient,
  writeResult,
  unknownAction,
  SYSTEM_PROMPT,
  urgentNotification,
  type ParallelAgent,
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

function resolveAlias(aliasOrSessionId: string): string | undefined {
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
// Plugin
// ============================================================================

const plugin: Plugin = async () => {
  log.info(LOG.HOOK, "Plugin initialized")
  
  return {
    tool: {
      iam: tool({
        description: TOOL_DESCRIPTION,
        args: {
          action: tool.schema.enum(["sessions", "read", "write", "announce"]).describe(
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
          
          log.debug(LOG.TOOL, `iam action: ${args.action}`, { sessionId, args })
          
          switch (args.action) {
            case "sessions": {
              const agents = getKnownAgents(sessionId)
              log.debug(LOG.TOOL, `sessions result`, { sessionId, agentCount: agents.length, agents })
              
              if (agents.length === 0) {
                return SESSIONS_EMPTY
              }
              
              // Build agent list with descriptions
              const agentsWithDesc = agents.map(alias => ({
                alias,
                description: getDescription(alias)
              }))
              
              return sessionsResult(agentsWithDesc)
            }
            
            case "read": {
              const messages = getAllMessages(sessionId)
              const unreadCount = messages.filter(m => !m.read).length
              log.debug(LOG.TOOL, `read iam`, { sessionId, total: messages.length, unread: unreadCount })
              
              // Mark all as read
              markAllRead(sessionId)
              
              if (messages.length === 0) {
                return READ_EMPTY
              }
              
              return readResult(messages, unreadCount)
            }
            
            case "write": {
              if (!args.to) {
                log.warn(LOG.TOOL, `write missing 'to'`, { sessionId })
                return WRITE_MISSING_TO
              }
              if (!args.message) {
                log.warn(LOG.TOOL, `write missing 'message'`, { sessionId })
                return WRITE_MISSING_MESSAGE
              }
              
              // Resolve alias to session ID
              const recipientSessionId = resolveAlias(args.to)
              if (!recipientSessionId) {
                log.warn(LOG.TOOL, `write unknown recipient`, { sessionId, to: args.to })
                return writeUnknownRecipient(args.to, getKnownAgents(sessionId))
              }
              
              // Store sender's alias (not session ID) so recipient sees friendly name
              const senderAlias = getAlias(sessionId)
              const msg = sendMessage(senderAlias, recipientSessionId, args.message)
              
              return writeResult(args.to, msg.id)
            }
            
            case "announce": {
              if (!args.message) {
                log.warn(LOG.TOOL, `announce missing 'message'`, { sessionId })
                return ANNOUNCE_MISSING_MESSAGE
              }
              
              setDescription(sessionId, args.message)
              const alias = getAlias(sessionId)
              
              // Gather info about all parallel agents
              const parallelAgents = getKnownAgents(sessionId).map(agentAlias => ({
                alias: agentAlias,
                description: getDescription(agentAlias)
              }))
              
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
      // Log ALL tool.execute.after calls to debug
      log.debug(LOG.HOOK, `tool.execute.after fired`, { tool: input.tool, sessionID: input.sessionID, hasMetadata: !!output.metadata })
      
      if (input.tool === "task") {
        // Log full metadata to see what's available
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
    
    // Inject system prompt with iam instructions
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SYSTEM_PROMPT)
    },
    
    // Inject urgent notification when there are unread messages
    "experimental.chat.messages.transform": async (_input, output) => {
      const lastUserMsg = [...output.messages].reverse().find(m => m.info.role === "user")
      if (!lastUserMsg) return
      
      const sessionId = lastUserMsg.info.sessionID
      const unread = getUnreadMessages(sessionId)
      
      if (unread.length === 0) return
      
      log.info(LOG.INJECT, `Injecting urgent notification`, { sessionId, unreadCount: unread.length })
      const notification = urgentNotification(unread.length)
      
      // Create synthetic user message
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
            text: notification,
          }
        ]
      }
      
      output.messages.push(syntheticMessage as any)
    },
  }
}

export default plugin
