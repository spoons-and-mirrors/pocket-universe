// =============================================================================
// Configuration for the Pocket Universe plugin
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

/** Session update configuration for broadcast events */
export interface SessionUpdateBroadcastConfig {
  /** Log status updates (broadcast without send_to) */
  status_update: boolean;
  /** Log messages sent to specific agents (broadcast with send_to) */
  message_sent: boolean;
}

/** Session update configuration for subagent events */
export interface SessionUpdateSubagentConfig {
  /** Log when a subagent is spawned */
  creation: boolean;
  /** Log when a subagent completes */
  completion: boolean;
  /** Log when a session is resumed */
  resumption: boolean;
}

/** Session update configuration for user /pocket command */
export interface SessionUpdateUserConfig {
  /** Log when user sends a message to an agent via /pocket */
  message_sent: boolean;
}

/** Session update configuration */
export interface SessionUpdateConfig {
  /** Broadcast-related events */
  broadcast: SessionUpdateBroadcastConfig;
  /** Subagent-related events */
  subagent: SessionUpdateSubagentConfig;
  /** User /pocket command events */
  user: SessionUpdateUserConfig;
}

/** Subagent tool configuration */
export interface SubagentConfig {
  /** Enable the subagent tool for creating sibling agents (default: true) */
  enabled: boolean;
  /**
   * Max session depth allowed to spawn subagents (main session = 0).
   * Sessions at or deeper than this cannot call the subagent tool.
   */
  max_depth: number;
  /**
   * When true (default), subagent results appear in the broadcast inbox
   * via synthetic injection. When false, subagent results are injected
   * as a persisted user message, forcing immediate LLM attention.
   */
  forced_attention: boolean;
}

/** Recall tool configuration */
export interface RecallConfig {
  /** Enable the recall tool for querying agent history (default: false) */
  enabled: boolean;
  /**
   * When true (default), recall tool can access agents from prior pocket universes.
   * When false, recall only shows agents from the current pocket universe.
   */
  cross_pocket: boolean;
}

/** Tools configuration */
export interface ToolsConfig {
  /** Enable the broadcast tool for inter-agent messaging (default: true) */
  broadcast: boolean;
  /** Subagent tool configuration */
  subagent: SubagentConfig;
  /** Recall tool configuration */
  recall: RecallConfig;
}

export interface PocketUniverseConfig {
  /** Enable isolated git worktrees for each agent (default: false) */
  worktree: boolean;
  /** Enable debug logging to .logs/pocket-universe.log (default: false) */
  logging: boolean;
  /** Send ignored user messages to main session on agent events */
  session_update: SessionUpdateConfig;
  /** Tools configuration */
  tools: ToolsConfig;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: PocketUniverseConfig = {
  worktree: false,
  logging: false,
  session_update: {
    broadcast: {
      status_update: false,
      message_sent: false,
    },
    subagent: {
      creation: false,
      completion: false,
      resumption: false,
    },
    user: {
      message_sent: false,
    },
  },
  tools: {
    broadcast: true,
    subagent: {
      enabled: true,
      max_depth: 3,
      forced_attention: true,
    },
    recall: {
      enabled: false,
      cross_pocket: true,
    },
  },
};

// ============================================================================
// Config Loading
// ============================================================================

// Config file locations (checked in order, first found wins)
const LOCAL_CONFIG_PATH = path.join(process.cwd(), '.pocket-universe.jsonc');
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'pocket-universe.jsonc');

let loadedConfig: PocketUniverseConfig = DEFAULT_CONFIG;
let configLoaded = false;
let activeConfigPath: string | null = null;

/**
 * Check if a value is a plain object (not null, array, or primitive)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep merge two objects, with source values overriding target values.
 * For nested objects, recursively merges. For primitives/arrays, source wins.
 * Returns a new object without mutating inputs.
 */
function deepMergeImpl(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];

    // If both are plain objects, recursively merge
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMergeImpl(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      // Otherwise, source value wins (if defined)
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Deep merge a partial config with defaults.
 * Type-safe wrapper around deepMergeImpl.
 */
function deepMergeConfig(
  defaults: PocketUniverseConfig,
  partial: Record<string, unknown>
): PocketUniverseConfig {
  const result = deepMergeImpl(defaults as unknown as Record<string, unknown>, partial);
  return result as unknown as PocketUniverseConfig;
}

/**
 * Deep merge two objects, with source values overriding target values.
 * For nested objects, recursively merges. For primitives/arrays, source wins.
 * Returns a new object without mutating inputs.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];

    // If both are plain objects, recursively merge
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMerge(targetValue as Record<string, unknown>, sourceValue);
    } else if (sourceValue !== undefined) {
      // Otherwise, source value wins (if defined)
      result[key] = sourceValue;
    }
  }

  return result as T;
}

/**
 * Strip comments from JSONC content
 */
function stripJsonComments(content: string): string {
  // Remove single-line comments (// ...)
  let result = content.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments (/* ... */)
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

/**
 * Strip trailing commas from JSON content (makes it valid JSON)
 */
function stripTrailingCommas(content: string): string {
  // Remove trailing commas before } or ]
  // This regex matches: comma, optional whitespace/newlines, then } or ]
  return content.replace(/,\s*([}\]])/g, '$1');
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
    const content = fs.readFileSync(configPath, 'utf-8');
    const jsonContent = stripTrailingCommas(stripJsonComments(content));
    const parsed = JSON.parse(jsonContent);

    // Validate parsed is a plain object before merging
    if (!isPlainObject(parsed)) {
      // Invalid config format (null, array, primitive) - use defaults
      loadedConfig = { ...DEFAULT_CONFIG };
    } else {
      // Deep merge with defaults to ensure all nested fields exist
      loadedConfig = deepMergeConfig(DEFAULT_CONFIG, parsed);
    }
  } catch {
    // Silently fall back to defaults on any error (read, parse, etc.)
    loadedConfig = { ...DEFAULT_CONFIG };
  }

  // Final defensive check: ensure critical nested objects exist
  // This catches edge cases like corrupted merges or future schema changes
  try {
    if (!loadedConfig.tools?.subagent || !loadedConfig.tools?.recall) {
      loadedConfig = deepMergeConfig(
        DEFAULT_CONFIG,
        loadedConfig as unknown as Record<string, unknown>
      );
    }
    if (!loadedConfig.session_update?.broadcast || !loadedConfig.session_update?.subagent) {
      loadedConfig = deepMergeConfig(
        DEFAULT_CONFIG,
        loadedConfig as unknown as Record<string, unknown>
      );
    }
  } catch {
    // If validation itself fails, fall back to pure defaults
    loadedConfig = { ...DEFAULT_CONFIG };
  }

  configLoaded = true;

  // Log loaded config values for debugging (only when logging is enabled)
  // This runs after configLoaded=true so isLoggingEnabled() works
  if (loadedConfig.logging) {
    // Defer import to avoid circular dependency
    import('./logger').then(({ log, LOG }) => {
      log.info(LOG.HOOK, `Config loaded`, {
        path: activeConfigPath,
        worktree: loadedConfig.worktree,
        logging: loadedConfig.logging,
        tools: loadedConfig.tools,
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
 * Check if broadcast tool is enabled
 */
export function isBroadcastEnabled(): boolean {
  return loadConfig().tools.broadcast;
}

/**
 * Check if subagent tool is enabled
 */
export function isSubagentEnabled(): boolean {
  return loadConfig().tools.subagent.enabled;
}

/**
 * Check if recall tool is enabled
 */
export function isRecallEnabled(): boolean {
  return loadConfig().tools.recall.enabled;
}

/**
 * Check if logging is enabled
 */
export function isLoggingEnabled(): boolean {
  return loadConfig().logging;
}

/**
 * Get max subagent nesting depth (minimum 0)
 */
export function getMaxSubagentDepth(): number {
  const depth = Number(loadConfig().tools.subagent.max_depth);
  return Number.isFinite(depth) && depth >= 0 ? depth : 0;
}

/**
 * Check if subagent result forced attention mode is enabled
 */
export function isSubagentResultForcedAttention(): boolean {
  return loadConfig().tools.subagent.forced_attention;
}

/**
 * Check if recall can access agents from prior pocket universes
 */
export function isRecallCrossPocket(): boolean {
  return loadConfig().tools.recall.cross_pocket;
}

/**
 * Get session update config
 */
export function getSessionUpdateConfig(): SessionUpdateConfig {
  return loadConfig().session_update;
}

/**
 * Check if status update notifications are enabled
 */
export function isStatusUpdateEnabled(): boolean {
  return loadConfig().session_update.broadcast.status_update;
}

/**
 * Check if message sent notifications are enabled
 */
export function isMessageSentEnabled(): boolean {
  return loadConfig().session_update.broadcast.message_sent;
}

/**
 * Check if subagent creation notifications are enabled
 */
export function isSubagentCreationEnabled(): boolean {
  return loadConfig().session_update.subagent.creation;
}

/**
 * Check if subagent completion notifications are enabled
 */
export function isSubagentCompletionEnabled(): boolean {
  return loadConfig().session_update.subagent.completion;
}

/**
 * Check if session resumption notifications are enabled
 */
export function isSessionResumptionEnabled(): boolean {
  return loadConfig().session_update.subagent.resumption;
}

/**
 * Check if user message sent notifications are enabled
 */
export function isUserMessageSentEnabled(): boolean {
  return loadConfig().session_update.user.message_sent;
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
  "tools": {
    "broadcast": true, // inter-agent messaging

    "subagent": {
      "enabled": true, // async, sibling subagents
      "max_depth": 3, // max depth allowed (main session = 0)
      // When true (default), subagent results appear in broadcast inbox.
      // When false, subagent results are injected as persisted user message.
      "forced_attention": true
    },

    "recall": {
      "enabled": false, // query current and past subagents
      "cross_pocket": true // access prior pocket universe agents
    }
  },

  // Show pocket universe updates in main session
  "session_update": {
    "broadcast": {
      "status_update": true,
      "message_sent": true
    },
    "subagent": {
      "creation": true,
      "completion": true,
      "resumption": true
    },
    "user": {
      "message_sent": true
    }
  },

  "logging": false, // debug logs

  // Enable isolated git worktrees for each agent
  // Each agent gets its own clean checkout from HEAD
  "worktree": false
}
`;
}
