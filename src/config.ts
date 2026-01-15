// =============================================================================
// Configuration for the Pocket Universe plugin
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Types
// ============================================================================

export interface PocketUniverseConfig {
  /** Enable isolated git worktrees for each agent (default: false) */
  worktree: boolean;
  /** Enable the subagent tool for creating sibling agents (default: true) */
  subagent: boolean;
  /** Enable the recall tool for querying agent history (default: true) */
  recall: boolean;
  /** Enable debug logging to .logs/pocket-universe.log (default: false) */
  logging: boolean;
  /**
   * Max subagent nesting depth (main session = 1).
   * At max depth, subagent tool cannot spawn more subagents.
   */
  max_subagent_depth: number;
  /**
   * When true (default), subagent results appear in the broadcast inbox
   * via synthetic injection. When false, subagent results are injected
   * as a persisted user message, forcing immediate LLM attention.
   */
  subagent_result_forced_attention: boolean;
  /**
   * When true, recall tool can access agents from prior pocket universes.
   * When false (default), recall only shows agents from the current pocket universe.
   */
  recall_cross_pocket: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: PocketUniverseConfig = {
  worktree: false,
  subagent: true,
  recall: true,
  logging: false,
  max_subagent_depth: 3,
  subagent_result_forced_attention: true,
  recall_cross_pocket: false,
};

// ============================================================================
// Config Loading
// ============================================================================

// Config file locations (checked in order, first found wins)
const LOCAL_CONFIG_PATH = path.join(process.cwd(), ".pocket-universe.jsonc");
const GLOBAL_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "pocket-universe.jsonc",
);

let loadedConfig: PocketUniverseConfig = DEFAULT_CONFIG;
let configLoaded = false;
let activeConfigPath: string | null = null;

/**
 * Strip comments from JSONC content
 */
function stripJsonComments(content: string): string {
  // Remove single-line comments (// ...)
  let result = content.replace(/\/\/.*$/gm, "");
  // Remove multi-line comments (/* ... */)
  result = result.replace(/\/\*[\s\S]*?\*\//g, "");
  return result;
}

/**
 * Find the config file to use (local takes priority over global)
 */
function findConfigPath(): string | null {
  // Check local config first (cwd)
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    return LOCAL_CONFIG_PATH;
  }
  // Fall back to global config
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    return GLOBAL_CONFIG_PATH;
  }
  return null;
}

/**
 * Ensure the global config file exists with default values
 */
function ensureGlobalConfigExists(): void {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    return;
  }

  try {
    // Ensure directory exists
    const configDir = path.dirname(GLOBAL_CONFIG_PATH);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Write default config
    fs.writeFileSync(GLOBAL_CONFIG_PATH, getConfigTemplate());
    // Silently create - no logging to console
  } catch {
    // Silently fail if we can't create the config
  }
}

/**
 * Load configuration from config file.
 * Priority: .pocket-universe.jsonc (cwd) > ~/.config/opencode/pocket-universe.jsonc
 * Creates global config with defaults if it doesn't exist.
 * Falls back to defaults if no file found or invalid.
 */
function loadConfig(): PocketUniverseConfig {
  if (configLoaded) {
    return loadedConfig;
  }

  // Ensure global config exists
  ensureGlobalConfigExists();

  const configPath = findConfigPath();
  activeConfigPath = configPath;

  if (!configPath) {
    loadedConfig = { ...DEFAULT_CONFIG };
    configLoaded = true;
    return loadedConfig;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const jsonContent = stripJsonComments(content);
    const parsed = JSON.parse(jsonContent);

    // Merge with defaults to ensure all fields exist
    loadedConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
    // Config loaded silently - no console output
  } catch {
    // Silently fall back to defaults on parse error
    loadedConfig = { ...DEFAULT_CONFIG };
  }

  configLoaded = true;

  // Log loaded config values for debugging (only when logging is enabled)
  // This runs after configLoaded=true so isLoggingEnabled() works
  if (loadedConfig.logging) {
    // Defer import to avoid circular dependency
    import("./logger").then(({ log, LOG }) => {
      log.info(LOG.HOOK, `Config loaded`, {
        path: activeConfigPath,
        worktree: loadedConfig.worktree,
        subagent: loadedConfig.subagent,
        recall: loadedConfig.recall,
        logging: loadedConfig.logging,
        max_subagent_depth: loadedConfig.max_subagent_depth,
        subagent_result_forced_attention:
          loadedConfig.subagent_result_forced_attention,
        recall_cross_pocket: loadedConfig.recall_cross_pocket,
      });
    });
  }

  return loadedConfig;
}

// ============================================================================
// Config Accessors
// ============================================================================

/**
 * Get the full configuration object
 */
export function getConfig(): PocketUniverseConfig {
  return loadConfig();
}

/**
 * Check if worktree feature is enabled
 */
export function isWorktreeEnabled(): boolean {
  return loadConfig().worktree;
}

/**
 * Check if subagent tool is enabled
 */
export function isSubagentEnabled(): boolean {
  return loadConfig().subagent;
}

/**
 * Check if recall tool is enabled
 */
export function isRecallEnabled(): boolean {
  return loadConfig().recall;
}

/**
 * Check if logging is enabled
 */
export function isLoggingEnabled(): boolean {
  return loadConfig().logging;
}

/**
 * Get max subagent nesting depth (minimum 1)
 */
export function getMaxSubagentDepth(): number {
  const depth = Number(loadConfig().max_subagent_depth);
  return Number.isFinite(depth) && depth >= 1 ? depth : 1;
}

/**
 * Check if subagent result forced attention mode is enabled
 */
export function isSubagentResultForcedAttention(): boolean {
  return loadConfig().subagent_result_forced_attention;
}

/**
 * Check if recall can access agents from prior pocket universes
 */
export function isRecallCrossPocket(): boolean {
  return loadConfig().recall_cross_pocket;
}

/**
 * Get the config file path that was used (or would be used)
 */
export function getConfigPath(): string | null {
  loadConfig(); // Ensure config is loaded
  return activeConfigPath;
}

// ============================================================================
// Config File Template
// ============================================================================

/**
 * Generate a template config file content (JSONC with comments)
 */
export function getConfigTemplate(): string {
  return `{
  // Enable isolated git worktrees for each agent
  // Each agent gets its own clean checkout from HEAD
  "worktree": false,

  // Enable the subagent tool for creating sibling agents
  // Allows agents to spawn other agents that run in parallel
  "subagent": true,

  // Enable the recall tool for querying agent history
  // Allows agents to recall what previous agents accomplished
  "recall": true,

  // Enable debug logging to .logs/pocket-universe.log
  "logging": false,

  // Max subagent nesting depth (main session = 1)
  "max_subagent_depth": 3,

  // When true (default), subagent results appear in broadcast inbox.
  // When false, subagent results are injected as persisted user message.
  "subagent_result_forced_attention": true,

  // When true, recall can access agents from prior pocket universes.
  // When false (default), recall only shows current pocket universe agents.
  "recall_cross_pocket": false
}
`;
}
