import { log, LOG } from '../logger';
import type { OpenCodeSessionClient, ConfigTransformOutput, Part } from '../types';
import { createBroadcastTool, createSubagentTool, createRecallTool } from '../tools/index';
import { isBroadcastEnabled, isSubagentEnabled, isRecallEnabled } from '../config';
import { parsePocketCommand, executePocketCommand } from '../commands/index';

export function createRegistry(client: OpenCodeSessionClient) {
  return {
    tool: {
      // Only register broadcast tool if enabled in config
      ...(isBroadcastEnabled() ? { broadcast: createBroadcastTool(client) } : {}),
      // Only register recall tool if enabled in config
      ...(isRecallEnabled() ? { recall: createRecallTool() } : {}),
      // Only register subagent tool if enabled in config
      ...(isSubagentEnabled() ? { subagent: createSubagentTool(client) } : {}),
    },

    // Intercept /pocket command before execution
    'command.execute.before': async (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: Part[] }
    ) => {
      if (input.command !== 'pocket') {
        return; // Not our command, let it pass through
      }

      log.info(LOG.HOOK, `/pocket command intercepted`, {
        sessionID: input.sessionID,
        arguments: input.arguments,
      });

      // Clear parts FIRST to prevent the command template from being sent to the main session's LLM
      // This stops the normal command execution flow - we handle it entirely in the plugin
      output.parts.length = 0;

      const parsed = parsePocketCommand(input.arguments);
      if (!parsed) {
        log.warn(LOG.HOOK, `/pocket command parse failed - empty input`);
        return;
      }

      const result = await executePocketCommand({
        message: parsed.message,
        target: parsed.target,
        mainSessionID: input.sessionID,
      });

      log.info(LOG.HOOK, `/pocket command result`, {
        success: result.success,
        message: result.message,
      });
    },

    // Register /pocket command and add tools to subagent_tools
    config: async (input: ConfigTransformOutput) => {
      // Register /pocket command
      input.command ??= {};
      input.command.pocket = {
        description: 'Send a message to agents in the pocket universe',
        template: '[ARGUMENTS]',
      };
      log.info(LOG.HOOK, `Registered /pocket command`);

      // Register skill paths (point to folder with SKILL.md files)
      input.skills ??= {};
      input.skills.paths ??= [];
      input.skills.paths.push('~/.config/opencode/plugin-test-skill');
      log.info(LOG.HOOK, `Registered skill paths`, { paths: input.skills.paths });

      // Add tools to subagent_tools
      const experimental = input.experimental ?? {};
      const existingSubagentTools = experimental.subagent_tools ?? [];
      const toolsToAdd = [
        ...(isBroadcastEnabled() ? ['broadcast'] : []),
        ...(isRecallEnabled() ? ['recall'] : []),
        ...(isSubagentEnabled() ? ['subagent'] : []),
      ];
      input.experimental = {
        ...experimental,
        subagent_tools: [...existingSubagentTools, ...toolsToAdd],
      };
      log.info(LOG.HOOK, `Added tools to experimental.subagent_tools`, {
        tools: toolsToAdd,
      });
    },
  };
}
