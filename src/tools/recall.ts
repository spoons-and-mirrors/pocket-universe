// =============================================================================
// Recall tool definition
// =============================================================================

import { tool } from "@opencode-ai/plugin";
import {
  RECALL_DESCRIPTION,
  recallNotFound,
  RECALL_EMPTY,
} from "../prompts/recall.prompts";
import { log, LOG } from "../logger";
import type { ToolContext } from "../types";
import { getAlias, recallAgents } from "../state";

export function createRecallTool() {
  return tool({
    description: RECALL_DESCRIPTION,
    args: {
      agent_name: tool.schema
        .string()
        .optional()
        .describe(
          "Specific agent to recall (e.g., 'agentA'). Omit to get all agents.",
        ),
      show_output: tool.schema
        .boolean()
        .optional()
        .describe(
          "Include the agent's final output. Only works when agent_name is specified.",
        ),
    },
    async execute(args, context: ToolContext) {
      const sessionId = context.sessionID;
      const alias = getAlias(sessionId);

      log.info(LOG.TOOL, `recall called`, {
        alias,
        targetAgent: args.agent_name || "all",
        showOutput: args.show_output || false,
      });

      const result = recallAgents(args.agent_name, args.show_output);

      if (result.agents.length === 0) {
        if (args.agent_name) {
          return recallNotFound(args.agent_name);
        }
        return RECALL_EMPTY;
      }

      // Format nicely for LLM
      return JSON.stringify(result, null, 2);
    },
  });
}
