// =============================================================================
// Inbox message creation for child sessions
// =============================================================================

import type {
  Message,
  UserMessage,
  AssistantMessage,
  ParallelAgent,
} from "../types";
import { ANNOUNCE_HINT } from "../prompts/injection";
import { log, LOG } from "../logger";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "../state";

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
