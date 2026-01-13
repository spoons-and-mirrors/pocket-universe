import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  BROADCAST_DESCRIPTION,
  BROADCAST_MISSING_MESSAGE,
  broadcastUnknownRecipient,
  broadcastResult,
  SYSTEM_PROMPT,
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
// Helper to create assistant message with tool part
// ============================================================================

function createAssistantMessageWithToolPart(
  sessionId: string,
  senderAlias: string,
  messageBody: string,
  messageId: string,
  timestamp: number,
  baseUserMessage: any
): any {
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
  
  return {
    info: {
      id: assistantMessageId,
      sessionID: sessionId,
      role: "assistant",
      agent: userInfo.agent || "code",
      parentID: userInfo.id,
      modelID: userInfo.model?.modelID || "gpt-4o-2024-08-06",
      providerID: userInfo.model?.providerID || "openai",
      mode: "default",
      path: {
        cwd: "/",
        root: "/",
      },
      time: { created: now, completed: now },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(userInfo.variant !== undefined && { variant: userInfo.variant }),
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
}

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized")
  const client = ctx.client
  
  return {
    tool: {
      broadcast: tool({
        description: BROADCAST_DESCRIPTION,
        args: {
          recipient: tool.schema.string().optional().describe("Target agent(s), comma-separated. Omit to send to all."),
          message: tool.schema.string().describe("Your message"),
        },
        async execute(args, context) {
          const sessionId = context.sessionID
          const isFirstCall = !activeSessions.has(sessionId)
          registerSession(sessionId)
          
          const alias = getAlias(sessionId)
          
          if (!args.message) {
            log.warn(LOG.TOOL, `broadcast missing 'message'`, { alias })
            return BROADCAST_MISSING_MESSAGE
          }
          
          // Use message as status description (only on first call)
          if (isFirstCall) {
            setDescription(sessionId, args.message.substring(0, 100))
          }
          
          log.debug(LOG.TOOL, `broadcast called`, { sessionId, alias, recipient: args.recipient, messageLength: args.message.length, isFirstCall })
          
          const knownAgents = getKnownAgents(sessionId)
          const parallelAgents = getParallelAgents(sessionId)
          let targetAliases: string[]
          
          if (!args.recipient) {
            // No target specified - send to all known agents
            targetAliases = knownAgents
          } else {
            targetAliases = args.recipient.split(",").map(s => s.trim()).filter(Boolean)
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
            // Skip sending to yourself
            if (recipientSessionId === sessionId) {
              log.warn(LOG.TOOL, `Skipping self-message`, { alias, targetAlias })
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
          
          let messageId = ""
          for (const recipientSessionId of recipientSessions) {
            const msg = sendMessage(alias, recipientSessionId, args.message)
            messageId = msg.id
            
            log.info(LOG.MESSAGE, `Message queued for recipient`, { 
              senderAlias: alias, 
              senderSessionId: sessionId,
              recipientSessionId,
              messageId: msg.id,
              messageLength: args.message.length,
              isParent: recipientSessionId === parentId
            })
          }
          
          // Only notify parent session (not siblings)
          if (isTargetingParent) {
            log.info(LOG.MESSAGE, `Broadcasting to parent session, calling notify_once`, { sessionId, parentId })
            try {
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
          
          return broadcastResult(alias, validTargets, messageId, parallelAgents, isFirstCall)
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
      
      // Inject IAM instructions for all sessions
      output.system.push(SYSTEM_PROMPT)
      log.info(LOG.INJECT, `Injected IAM system prompt`, { sessionId })
    },
    
    // NOTE: No longer injecting synthetic user messages for unread notifications
    // Messages are now injected directly into recipient sessions as assistant messages with tool parts
    // when broadcast is called
    
    // Inject assistant messages with tool parts for unread IAM messages
    "experimental.chat.messages.transform": async (_input, output) => {
      const lastUserMsg = [...output.messages].reverse().find(m => m.info.role === "user")
      if (!lastUserMsg) {
        log.debug(LOG.INJECT, `No user message found in transform, skipping IAM injection`)
        return
      }
      
      const sessionId = lastUserMsg.info.sessionID
      const unread = getUnreadMessages(sessionId)
      
      log.debug(LOG.INJECT, `Checking for unread messages in transform`, { sessionId, unreadCount: unread.length })
      
      if (unread.length === 0) {
        return
      }
      
      log.info(LOG.INJECT, `Injecting ${unread.length} assistant message(s) with tool parts`, { 
        sessionId, 
        unreadCount: unread.length,
        messageIds: unread.map(m => m.id)
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
        
        output.messages.push(assistantMsg)
        
        log.info(LOG.INJECT, `Injected assistant message with tool part`, { 
          sessionId,
          senderAlias: msg.from,
          messageId: assistantMsg.info.id,
          partId: assistantMsg.parts[0].id
        })
        
        // Mark as read after injection
        msg.read = true
      }
      
      log.info(LOG.INJECT, `Marked ${unread.length} messages as read after injection`, { sessionId })
    },
    
    // Add broadcast to subagent_tools
    "experimental.config.transform": async (_input: any, output: any) => {
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
