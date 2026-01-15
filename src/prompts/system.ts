import {
  isWorktreeEnabled,
  isSubagentEnabled,
  isRecallEnabled,
} from "../config";

// =============================================================================
// System prompt injection
// =============================================================================

// =============================================================================
// Conditional Sections
// =============================================================================

const SECTION_SUBAGENT_INTRO =
  "Use `subagent` to create new sibling agents for parallel work.";

const SECTION_SUBAGENT_MAX_DEPTH = (depth?: number, maxDepth?: number) => {
  if (depth && maxDepth) {
    return `You have reached the maximum subagent depth (${depth}/${maxDepth}) and cannot call \`subagent\` from this session.`;
  }
  return "You have reached the maximum subagent depth and cannot call `subagent` from this session.";
};

const SECTION_WORKTREE = `
## Isolated Worktrees
Each agent operates in its own isolated git worktree - a clean checkout from the last commit.
- Your worktree path is shown in your system prompt (if available)
- **ALL file operations should use paths relative to or within your worktree**
- Do NOT modify files outside your assigned worktree
- Other agents have their own worktrees - coordinate via broadcast, don't touch their files`;

const SECTION_SUBAGENT = `
## Spawning Agents
- \`subagent(prompt="...", description="...")\` → create a sibling agent
- **Fire-and-forget**: subagent() returns immediately, you continue working
- **Output piping**: When subagent completes, its output arrives as a message`;

const SECTION_SUBAGENT_WORKTREE_NOTE = `
- Subagents get their own isolated worktrees`;

const SECTION_RECALL = `
## Querying Agent History
Use \`recall()\` to see all agents and their status history. Use \`recall(agent_name="X", show_output=true)\` to retrieve a completed agent's final output.`;

const SECTION_SUBAGENT_FOOTER = `
When you receive output from a subagent, process it and incorporate the results.`;

// =============================================================================
// Template
// =============================================================================

/**
 * Get the system prompt, dynamically including sections based on config.
 */
export function getSystemPrompt(options?: {
  allowSubagent?: boolean;
  depth?: number;
  maxDepth?: number;
}): string {
  const worktree = isWorktreeEnabled();
  const subagent = isSubagentEnabled();
  const recall = isRecallEnabled();
  const allowSubagent = options?.allowSubagent ?? subagent;

  // Dynamic content based on worktree config
  const agentExample = worktree
    ? `{ name: "agentA", status: "Working on X", worktree: "/path/to/.worktrees/agentA" }`
    : `{ name: "agentA", status: "Working on X" }`;

  const agentsDescription = worktree
    ? `- **agents**: Other agents, their status, and their worktree paths`
    : `- **agents**: Other agents and their current status`;

  const subagentIntro = subagent
    ? allowSubagent
      ? SECTION_SUBAGENT_INTRO
      : SECTION_SUBAGENT_MAX_DEPTH(options?.depth, options?.maxDepth)
    : "";
  const subagentSection =
    subagent && allowSubagent
      ? `${SECTION_SUBAGENT}${worktree ? SECTION_SUBAGENT_WORKTREE_NOTE : ""}`
      : "";
  const subagentFooter =
    subagent && allowSubagent ? SECTION_SUBAGENT_FOOTER : "";

  const lines = [
    '<instructions tool="pocket-universe">',
    "# Pocket Universe — Parallel Agent Orchestration",
    "",
    "Use `broadcast` to communicate with other parallel agents.",
    subagentIntro,
    "",
    "## IMPORTANT: Announce Yourself First",
    "Your first action should be calling `broadcast(message=\"what you're working on\")` to announce yourself. Until you do, other agents won't know your purpose.",
    "",
    `**Status updates**: Calling \`broadcast(message="...")\` without \`send_to\` updates your status. This is passive visibility — other agents see your status history when they broadcast. Use status updates to track progress (e.g., "searching for X", "found X", "implementing Y"). Status updates do NOT send messages or wake other agents.${worktree ? SECTION_WORKTREE : ""}`,
    "",
    "## Sending Messages",
    '- `broadcast(message="...")` → **status update** (visible to all, not a message)',
    '- `broadcast(send_to="agentB", message="...")` → send message to specific agent',
    '- `broadcast(reply_to=1, message="...")` → reply to message #1',
    "",
    `**Important:** Broadcasting without \`send_to\` updates your status but does NOT queue a message. Use \`send_to\` for direct communication that needs a reply.${subagentSection}${recall ? SECTION_RECALL : ""}`,
    "",
    "## Receiving Messages",
    "Messages appear as synthetic `broadcast` tool results:",
    "```",
    "{",
    `  agents: [${agentExample}],`,
    `  messages: [{ id: 1, from: "agentA", content: "..." }]`,
    "}",
    "```",
    "",
    agentsDescription,
    `- **messages**: Messages to reply to using \`reply_to\`${subagentFooter}`,
    "</instructions>",
  ];

  return lines.join("\n");
}

// Legacy export for backwards compatibility (but prefer getSystemPrompt())
export const SYSTEM_PROMPT = getSystemPrompt();

// =============================================================================
// Worktree system prompt
// =============================================================================

export function getWorktreeSystemPrompt(worktreePath: string): string {
  return `
<worktree>
Your isolated working directory: ${worktreePath}
ALL file operations (read, write, edit, bash) should use paths within this directory.
Do NOT modify files outside this worktree.
</worktree>
`;
}
