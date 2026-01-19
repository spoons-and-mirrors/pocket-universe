// =============================================================================
// /pocket command - send messages to agents in the current pocket universe
// =============================================================================

import { log, LOG } from '../logger';
import {
  getCurrentPocketId,
  aliasToSession,
  cleanedUpSessions,
  mainSessionCoordinator,
  getStoredClient,
  getOrFetchModelInfo,
  sessionToRootId,
} from '../state';
import { sendUserMessageSent } from '../messaging/session-update';

// ============================================================================
// Types
// ============================================================================

export interface PocketCommandArgs {
  /** The message to send */
  message: string;
  /** Target agent alias (optional, defaults to coordinator) */
  target?: string;
  /** The main session ID where command was invoked */
  mainSessionID: string;
}

export interface PocketCommandResult {
  success: boolean;
  message: string;
}

// ============================================================================
// Parsing
// ============================================================================
// Types
// ============================================================================

export interface PocketCommandArgs {
  /** The message to send */
  message: string;
  /** Target agent alias (optional, defaults to coordinator) */
  target?: string;
  /** The main session ID where command was invoked */
  mainSessionID: string;
}

export interface PocketCommandResult {
  success: boolean;
  message: string;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse the /pocket command input.
 * Supports:
 *   /pocket @agentB wrap it up  → target: "agentB", message: "wrap it up"
 *   /pocket wrap it up          → target: undefined (coordinator), message: "wrap it up"
 */
export function parsePocketCommand(input: string): { target?: string; message: string } | null {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // Check for @target pattern at the start
  const match = trimmed.match(/^@(\w+)\s+(.+)$/s);
  if (match) {
    return { target: match[1], message: match[2].trim() };
  }

  // No target, entire input is the message
  return { message: trimmed };
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Format the user message for injection into the agent's session.
 */
function formatUserMessage(message: string): string {
  return `**Message from user:**

${message}`;
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the /pocket command.
 * Injects a REAL user message into the target agent's session using client.session.prompt().
 * This message is persisted to DB and visible in the session UI.
 *
 * Safety checks:
 * - Pocket must be active (getCurrentPocketId is not null)
 * - Target agent must exist in current pocket (in aliasToSession)
 * - Target must NOT be from a previous pocket (not in cleanedUpSessions)
 */
export async function executePocketCommand(args: PocketCommandArgs): Promise<PocketCommandResult> {
  const { message, target, mainSessionID } = args;

  log.info(LOG.MESSAGE, `/pocket command invoked`, {
    mainSessionID,
    target: target || 'coordinator',
    messageLength: message.length,
  });

  // Check if pocket is active
  const pocketId = getCurrentPocketId();
  if (!pocketId) {
    log.warn(LOG.MESSAGE, `/pocket failed - no active pocket`);
    return {
      success: false,
      message: 'No active pocket universe. Start a task first.',
    };
  }

  // Resolve target agent
  let targetSessionId: string | undefined;
  let targetAlias: string;

  if (target) {
    // Explicit target specified
    targetAlias = target;
    targetSessionId = aliasToSession.get(target);
  } else {
    // Use coordinator (first child)
    const coordinator = mainSessionCoordinator.get(mainSessionID);
    if (!coordinator) {
      log.warn(LOG.MESSAGE, `/pocket failed - no coordinator found`, {
        mainSessionID,
      });
      return {
        success: false,
        message: 'No coordinator found. No agents in the current pocket.',
      };
    }
    targetSessionId = coordinator.sessionId;
    targetAlias = coordinator.alias;
  }

  // Check agent exists in current pocket
  if (!targetSessionId) {
    log.warn(LOG.MESSAGE, `/pocket failed - agent not found`, {
      target,
    });
    return {
      success: false,
      message: `Agent '${target}' not found in current pocket.`,
    };
  }

  // Safety: Check agent belongs to the current main session
  // Main sessions are completely isolated - agents NEVER cross main sessions
  const agentRootId = sessionToRootId.get(targetSessionId);
  if (target && agentRootId !== mainSessionID) {
    log.warn(LOG.MESSAGE, `/pocket failed - agent from different main session`, {
      targetAlias,
      targetSessionId,
      agentRootId,
      expectedMainSession: mainSessionID,
    });
    return {
      success: false,
      message: `Agent '${targetAlias}' belongs to a different session.`,
    };
  }

  // Safety: Check not from previous pocket (cleaned up)
  if (cleanedUpSessions.has(targetSessionId)) {
    log.warn(LOG.MESSAGE, `/pocket failed - agent from previous pocket`, {
      targetAlias,
      targetSessionId,
    });
    return {
      success: false,
      message: `Agent '${targetAlias}' is from a previous pocket and has completed.`,
    };
  }

  // Get the stored client to inject the message
  const client = getStoredClient();
  if (!client) {
    log.error(LOG.MESSAGE, `/pocket failed - no stored client available`);
    return {
      success: false,
      message: 'Internal error: client not available.',
    };
  }

  // Format the message
  const formattedMessage = formatUserMessage(message);

  try {
    // Get the target session's agent/model info
    // First checks stored info, then fetches from session messages as fallback
    const modelInfo = await getOrFetchModelInfo(client, targetSessionId);

    log.debug(LOG.MESSAGE, `/pocket using model info`, {
      targetAlias,
      targetSessionId,
      agent: modelInfo?.agent,
      modelID: modelInfo?.model?.modelID,
      providerID: modelInfo?.model?.providerID,
    });

    // Inject as a REAL persisted user message that triggers a response
    // Unlike noReply:true (used in session.before_complete), we want the agent
    // to actually respond to this message, even if mid-turn
    await client.session.prompt({
      path: { id: targetSessionId },
      body: {
        parts: [{ type: 'text', text: formattedMessage }],
        agent: modelInfo?.agent,
        model: modelInfo?.model,
      } as unknown as {
        parts: Array<{ type: string; text: string }>;
        agent?: string;
        model?: { modelID?: string; providerID?: string };
      },
    });

    log.info(LOG.MESSAGE, `/pocket injected user message to agent session`, {
      targetAlias,
      targetSessionId,
      messageLength: message.length,
    });

    // Send session update notification
    sendUserMessageSent(targetAlias, message);

    return {
      success: true,
      message: `Message sent to ${targetAlias}.`,
    };
  } catch (e) {
    log.error(LOG.MESSAGE, `/pocket failed to inject message`, {
      targetAlias,
      targetSessionId,
      error: String(e),
    });
    return {
      success: false,
      message: `Failed to send message to ${targetAlias}: ${String(e)}`,
    };
  }
}

// ============================================================================
// Command Definition (for OpenCode plugin registration)
// ============================================================================

export const POCKET_COMMAND_DESCRIPTION = `Send a message to agents in the current pocket universe.

Usage:
  /pocket @agentB wrap it up   → sends to agentB
  /pocket wrap it up           → sends to coordinator (first agent)

The message appears as a user message in the agent's session.`;
