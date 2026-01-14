import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Simple file logger for debugging the Pocket Universe plugin
// Only active when OPENCODE_POCKET_UNIVERSE_DEBUG_LOGS=1 is set in the environment
// =============================================================================

// Check if debug logging is enabled
const DEBUG_ENABLED = process.env.OPENCODE_POCKET_UNIVERSE_DEBUG_LOGS === "1";

// Constants
const LOG_DIR = path.join(process.cwd(), ".logs");
const LOG_FILE = path.join(LOG_DIR, "pocket-universe.log");
const WRITE_INTERVAL_MS = 100; // Batch writes every 100ms

// Async log buffer
let logBuffer: string[] = [];
let writeScheduled = false;

// Only initialize log directory if debug is enabled
if (DEBUG_ENABLED) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    // Clear log file on each restart
    fs.writeFileSync(LOG_FILE, "");
  } catch {
    // Ignore errors during init
  }
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Flush buffered logs to file asynchronously
 */
async function flushLogs(): Promise<void> {
  if (logBuffer.length === 0) {
    writeScheduled = false;
    return;
  }

  const toWrite = logBuffer.join("");
  logBuffer = [];
  writeScheduled = false;

  try {
    await fs.promises.appendFile(LOG_FILE, toWrite);
  } catch {
    // Silently fail if we can't write
  }
}

/**
 * Schedule a batched write if not already scheduled
 */
function scheduleFlush(): void {
  if (!writeScheduled) {
    writeScheduled = true;
    setTimeout(flushLogs, WRITE_INTERVAL_MS);
  }
}

function writeLog(
  level: LogLevel,
  category: string,
  message: string,
  data?: unknown,
): void {
  // Skip all logging if debug is not enabled
  if (!DEBUG_ENABLED) {
    return;
  }

  const timestamp = formatTimestamp();
  const dataStr = data !== undefined ? ` | ${JSON.stringify(data)}` : "";
  const logLine = `[${timestamp}] [${level}] [${category}] ${message}${dataStr}\n`;

  logBuffer.push(logLine);
  scheduleFlush();
}

export const log = {
  debug: (category: string, message: string, data?: unknown) =>
    writeLog("DEBUG", category, message, data),

  info: (category: string, message: string, data?: unknown) =>
    writeLog("INFO", category, message, data),

  warn: (category: string, message: string, data?: unknown) =>
    writeLog("WARN", category, message, data),

  error: (category: string, message: string, data?: unknown) =>
    writeLog("ERROR", category, message, data),

  /** Force immediate flush (useful before process exit) */
  flush: flushLogs,
};

// Log categories
export const LOG = {
  TOOL: "TOOL",
  MESSAGE: "MESSAGE",
  SESSION: "SESSION",
  HOOK: "HOOK",
  INJECT: "INJECT",
} as const;
