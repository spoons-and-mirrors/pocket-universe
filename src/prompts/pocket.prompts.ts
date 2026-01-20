// =============================================================================
// /pocket command prompts
// =============================================================================

import { render } from './render';

// =============================================================================
// TEMPLATES
// =============================================================================

const USER_MESSAGE_TEMPLATE = `**Message from user:**

{{message}}`;

export const POCKET_COMMAND_DESCRIPTION = `Send a message to agents in the current pocket universe.

Usage:
  /pocket @agentB wrap it up   → sends to agentB
  /pocket wrap it up           → sends to coordinator (first agent)

The message appears as a user message in the agent's session.`;

// =============================================================================
// RENDER FUNCTIONS
// =============================================================================

export function formatUserMessage(message: string): string {
  return render(USER_MESSAGE_TEMPLATE, { message });
}
