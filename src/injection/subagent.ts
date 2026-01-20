// =============================================================================
// Subagent injection helpers
// =============================================================================

import type {
  OpenCodeSessionClient,
  UserMessage,
  AssistantMessage,
  SubagentInfo,
  InternalClient,
} from '../types';
import {
  agentCompletedMessage,
  agentCompletedWithSummary,
  subagentCompletedSummary,
  subagentRunningMessage,
  subagentTaskOutput,
} from '../prompts/injection';
import { log, LOG } from '../logger';
import { activeSubagents, sessionToAlias, DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from '../state';
import { getParentIdForSubagent } from './session';

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
  const output = subagentTaskOutput(subagent.alias, subagent.description);

  log.info(LOG.MESSAGE, `Creating synthetic task injection`, {
    parentSessionId,
    subagentAlias: subagent.alias,
    subagentSessionId: subagent.sessionId,
  });

  const result: AssistantMessage = {
    info: {
      id: assistantMessageId,
      sessionID: parentSessionId,
      role: 'assistant',
      agent: userInfo.agent || 'code',
      parentID: userInfo.id,
      modelID: userInfo.model?.modelID || DEFAULT_MODEL_ID,
      providerID: userInfo.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: 'default',
      path: { cwd: '/', root: '/' },
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
        type: 'tool',
        callID: callId,
        tool: 'task',
        state: {
          status: 'completed',
          input: {
            description: subagent.description,
            prompt: subagent.prompt,
            subagent_type: 'general',
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
    const lastAssistantMsg = [...messages].reverse().find((m) => m.info.role === 'assistant');

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
      type: 'tool',
      callID: callId,
      tool: 'task',
      state: {
        status: 'running', // Show as running since it's executing in parallel
        input: {
          description: subagent.description,
          prompt: subagent.prompt,
          subagent_type: 'general',
        },
        output: subagentRunningMessage(subagent.alias),
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
    const httpClient = (client as unknown as { client?: InternalClient }).client;
    if (!httpClient?.patch) {
      // Try alternative access pattern
      const altClient = (client as unknown as { _client?: InternalClient })._client;
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
      return agentCompletedMessage(alias);
    }

    // Find assistant messages and extract text parts (like native Task tool does)
    const assistantMessages = messages.filter((m) => m.info.role === 'assistant');

    if (assistantMessages.length === 0) {
      log.warn(LOG.TOOL, `No assistant messages in subagent session`, {
        sessionId,
        alias,
      });
      return agentCompletedMessage(alias);
    }

    // Get the last assistant message
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const parts = lastAssistant.parts || [];

    // Find the last text part (like native Task tool: result.parts.findLast(x => x.type === "text"))
    const textParts = parts.filter((p: unknown) => (p as { type?: string }).type === 'text');
    const lastTextPart = textParts[textParts.length - 1] as { text?: string } | undefined;
    const text = lastTextPart?.text || '';

    if (text) {
      log.info(LOG.TOOL, `Extracted output from subagent session`, {
        sessionId,
        alias,
        textLength: text.length,
      });
      return text;
    }

    // Fallback: summarize tool calls if no text
    const toolParts = parts.filter((p: unknown) => (p as { type?: string }).type === 'tool');
    if (toolParts.length > 0) {
      const summary = toolParts
        .map((p: unknown) => {
          const part = p as { tool?: string; state?: { title?: string } };
          return `- ${part.tool}: ${part.state?.title || 'completed'}`;
        })
        .join('\n');
      return agentCompletedWithSummary(alias, summary);
    }

    return agentCompletedMessage(alias);
  } catch (e) {
    log.error(LOG.TOOL, `Failed to fetch subagent output`, {
      sessionId,
      alias,
      error: String(e),
    });
    return agentCompletedMessage(alias);
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
  if (!subagent.partId || !subagent.parentMessageId || !subagent.parentSessionId) {
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
  if (!subagent.partId || !subagent.parentMessageId || !subagent.parentSessionId) {
    // Get the parent session ID from the subagent session
    const parentId =
      subagent.parentSessionId || (await getParentIdForSubagent(client, subagent.sessionId));
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
      log.warn(LOG.TOOL, `No messages in parent session for completion injection`, {
        parentId,
        alias: subagent.alias,
      });
      return false;
    }

    const lastAssistantMsg = [...messages].reverse().find((m) => m.info.role === 'assistant');

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
  const summaryOutput = subagentCompletedSummary(subagent.alias);

  const completedPart = {
    id: subagent.partId,
    sessionID: subagent.parentSessionId,
    messageID: subagent.parentMessageId,
    type: 'tool',
    callID: `call_sub_${subagent.sessionId.slice(-12)}`,
    tool: 'task',
    state: {
      status: 'completed',
      input: {
        description: subagent.description,
        prompt: subagent.prompt,
        subagent_type: 'general',
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
    const httpClient = (client as unknown as { client?: InternalClient }).client;
    const altClient = (client as unknown as { _client?: InternalClient })._client;
    const patchClient = httpClient?.patch ? httpClient : altClient?.patch ? altClient : null;

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
