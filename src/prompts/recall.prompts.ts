export const RECALL_DESCRIPTION = `Recall the history and status of agents in this Pocket Universe.

Use this to learn what previous agents accomplished, even if they completed before you started.

- Call with no parameters to get all agents' status histories
- Call with agent_name to get a specific agent's history
- Call with agent_name AND show_output=true to also see their final output

Output is only shown when requesting a specific agent with show_output=true.`;

export function recallNotFound(agentName: string): string {
  return `No agent found with name '${agentName}'.`;
}

export const RECALL_EMPTY = `No agents in history yet.`;

export const RECALL_AGENT_ACTIVE = `[Agent is still active - no output yet]`;
export const RECALL_AGENT_IDLE_NO_OUTPUT = `[Agent is idle but has not produced output yet]`;
