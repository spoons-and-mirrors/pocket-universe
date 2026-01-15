import type { Plugin } from "@opencode-ai/plugin";
import { log, LOG } from "./logger";
import type { OpenCodeSessionClient } from "./types";
import { setStoredClient } from "./state";
import { createHooks } from "./plugin/hooks";
import { createRegistry } from "./plugin/registry";

// ============================================================================
// Plugin
// ============================================================================

const plugin: Plugin = async (ctx) => {
  log.info(LOG.HOOK, "Plugin initialized");
  const client = ctx.client as unknown as OpenCodeSessionClient;

  // Store client for resumption calls
  setStoredClient(client);

  return {
    ...createHooks(client),
    ...createRegistry(client),
  };
};

export default plugin;
