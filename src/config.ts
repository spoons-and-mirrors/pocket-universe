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
  /** Enable the spawn tool for creating sibling agents (default: false) */
  spawn: boolean;
  /** Enable debug logging to .logs/pocket-universe.log (default: false) */
  logging: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: PocketUniverseConfig = {
  worktree: false,
  spawn: true,
  logging: false,
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
    console.error(
      `[Pocket Universe] Created default config at ${GLOBAL_CONFIG_PATH}`,
    );
  } catch (e) {
    // Silently fail if we can't create the config
    console.error(
      `[Pocket Universe] Failed to create config at ${GLOBAL_CONFIG_PATH}:`,
      e,
    );
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

    // Log that config was loaded (to stderr since logging might not be enabled yet)
    if (loadedConfig.logging) {
      console.error(
        `[Pocket Universe] Config loaded from ${configPath}:`,
        loadedConfig,
      );
    }
  } catch (e) {
    console.error(
      `[Pocket Universe] Failed to load config from ${configPath}:`,
      e,
    );
    loadedConfig = { ...DEFAULT_CONFIG };
  }

  configLoaded = true;
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
 * Check if spawn tool is enabled
 */
export function isSpawnEnabled(): boolean {
  return loadConfig().spawn;
}

/**
 * Check if logging is enabled
 */
export function isLoggingEnabled(): boolean {
  return loadConfig().logging;
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

  // Enable the spawn tool for creating sibling agents
  // Allows agents to spawn other agents that run in parallel
  "spawn": true,

  // Enable debug logging to .logs/pocket-universe.log
  "logging": false
}
`;
}
