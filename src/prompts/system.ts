// =============================================================================
// System prompt for Pocket Universe
// =============================================================================
//
// This file contains the FULL system prompt as a single readable template.
// Sections are marked with {{condition}}...{{condition}} tags.
// The parser strips sections where the condition is false.
//
// Conditions:
//   {{broadcast}}         - broadcast tool enabled
//   {{worktree}}          - worktree isolation enabled
//   {{subagent}}          - subagent tool enabled
//   {{recall}}            - recall tool enabled
//   {{max_depth_reached}} - at max subagent depth (can't spawn more)
//
// Placeholders:
//   {{WORKTREE_PATH}}     - replaced with actual worktree path
//
// =============================================================================

import {
  isBroadcastEnabled,
  isWorktreeEnabled,
  isSubagentEnabled,
  isRecallEnabled,
} from '../config';

// =============================================================================
// TEMPLATE PARSER
// =============================================================================

/**
 * Parse a template with {{condition}}...{{condition}} blocks.
 * Keeps content if condition is true, strips if false.
 * Supports nesting.
 */
function parseTemplate(
  template: string,
  conditions: Record<string, boolean>,
  substitutions?: Record<string, string>
): string {
  let result = template;

  // Process each condition - find matching pairs and keep/strip content
  for (const [condition, enabled] of Object.entries(conditions)) {
    const regex = new RegExp(`{{${condition}}}([\\s\\S]*?){{${condition}}}`, 'g');

    if (enabled) {
      // Keep the content, remove the tags
      result = result.replace(regex, '$1');
    } else {
      // Strip the entire block including content
      result = result.replace(regex, '');
    }
  }

  // Substitute placeholders like {{WORKTREE_PATH}}
  if (substitutions) {
    for (const [key, value] of Object.entries(substitutions)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
  }

  // Clean up: collapse multiple blank lines into max 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

// =============================================================================
// SYSTEM PROMPT TEMPLATE
// =============================================================================
//
// Read this as the "full" prompt with all features enabled.
// Each {{tag}}...{{tag}} section is conditionally included.
//

const SYSTEM_PROMPT_TEMPLATE = `<instructions tool="pocket-universe">
# Pocket Universe — Parallel Agent Orchestration

{{broadcast}}
Use \`broadcast\` to communicate with other parallel agents.
{{broadcast}}
{{subagent}}
Use \`subagent\` to create new sibling agents for parallel work.
{{subagent}}
{{max_depth_reached}}
You have reached maximum subagent depth and cannot spawn more subagents from this session.
{{max_depth_reached}}

{{broadcast}}
## IMPORTANT: Announce Yourself First
Your first action should be calling \`broadcast(message="what you're working on")\` to announce yourself. Until you do, other agents won't know your purpose.

**Status updates**: Calling \`broadcast(message="...")\` without \`send_to\` updates your status. This is passive visibility — other agents see your status history when they broadcast. Use status updates to track progress (e.g., "searching for X", "found X", "implementing Y"). Status updates do NOT send messages or wake other agents.
{{broadcast}}

{{worktree}}
## Isolated Worktrees
Each agent operates in its own isolated git worktree - a clean checkout from the last commit.
- Your worktree path: \`{{WORKTREE_PATH}}\`
- **ALL file operations should use paths within your worktree**
- Do NOT modify files outside your assigned worktree
- Other agents have their own worktrees - coordinate via broadcast, don't touch their files
{{worktree}}

{{broadcast}}
## Sending Messages
- \`broadcast(message="...")\` → **status update** (visible to all, not a message)
- \`broadcast(send_to="agentB", message="...")\` → send message to specific agent
- \`broadcast(reply_to=1, message="...")\` → reply to message #1

**Important:** Broadcasting without \`send_to\` updates your status but does NOT queue a message. Use \`send_to\` for direct communication that needs a reply.
{{broadcast}}

{{subagent}}
## Spawning Agents
- \`subagent(prompt="...", description="...", subagent_type="...")\` → create a sibling agent
- Omitting \`subagent_type\` defaults to your current agent type
- **Fire-and-forget**: subagent() returns immediately, you continue working
- **Output piping**: When subagent completes, its output arrives as a message
{{subagent_types}}

Available agent types:
{{SUBAGENT_TYPES_LIST}}
{{subagent_types}}
{{worktree}}
- Subagents get their own isolated worktrees
{{worktree}}
{{subagent}}

{{recall}}
## Querying Agent History
Use \`recall()\` to see all agents and their status history. Use \`recall(agent_name="X", show_output=true)\` to retrieve a completed agent's final output.
{{recall}}

{{broadcast}}
## Receiving Messages
Messages appear as synthetic \`broadcast\` tool results:
\`\`\`
{
  agents: [{ name: "agentA", status: "Working on X"{{worktree}}, worktree: "/path/to/.worktrees/agentA"{{worktree}} }],
  messages: [{ id: 1, from: "agentA", content: "..." }]
}
\`\`\`

- **agents**: Other agents, their status{{worktree}}, and their worktree paths{{worktree}}
- **messages**: Messages to reply to using \`reply_to\`
{{broadcast}}

{{subagent}}
When you receive output from a subagent, process it and incorporate the results.
{{subagent}}
</instructions>`;

// =============================================================================
// PUBLIC API
// =============================================================================

export interface SystemPromptOptions {
  /** The agent's worktree path (if in a worktree) */
  worktreePath?: string;
  /** Whether max subagent depth has been reached */
  maxDepthReached?: boolean;
  /** Available subagent types from /agent endpoint */
  subagentTypes?: Array<{ name: string; description?: string }>;
}

/**
 * Get the system prompt, conditionally including sections based on config.
 */
export function getSystemPrompt(options?: SystemPromptOptions): string {
  const worktreeEnabled = isWorktreeEnabled();
  const hasSubagentTypes = !!(options?.subagentTypes && options.subagentTypes.length > 0);

  const conditions = {
    broadcast: isBroadcastEnabled(),
    worktree: worktreeEnabled && !!options?.worktreePath,
    subagent: isSubagentEnabled() && !options?.maxDepthReached,
    recall: isRecallEnabled(),
    max_depth_reached: !!options?.maxDepthReached,
    subagent_types: hasSubagentTypes,
  };

  const substitutions: Record<string, string> = {};
  if (options?.worktreePath) {
    substitutions.WORKTREE_PATH = options.worktreePath;
  }
  if (hasSubagentTypes && options?.subagentTypes) {
    substitutions.SUBAGENT_TYPES_LIST = options.subagentTypes
      .map((t) => `- **${t.name}**${t.description ? `: ${t.description}` : ''}`)
      .join('\n');
  }

  return parseTemplate(SYSTEM_PROMPT_TEMPLATE, conditions, substitutions);
}

// Legacy export for backwards compatibility
export const SYSTEM_PROMPT = getSystemPrompt();
