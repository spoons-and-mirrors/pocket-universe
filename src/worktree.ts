// =============================================================================
// Git worktree management for isolated agent working directories
// =============================================================================

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import { log, LOG } from "./logger";
import { WORKTREES_DIR } from "./state";

const execAsync = promisify(exec);

/**
 * Check if we're in a git repository
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --git-dir", { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory
 */
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Create a git worktree for an agent.
 * Creates a detached worktree from HEAD (clean state, last commit).
 * Returns the absolute path to the worktree, or null if not in a git repo.
 */
export async function createAgentWorktree(
  alias: string,
  cwd: string,
): Promise<string | null> {
  const gitRoot = await getGitRoot(cwd);
  if (!gitRoot) {
    log.warn(LOG.TOOL, `Cannot create worktree - not in a git repo`, { cwd });
    return null;
  }

  const worktreesDir = path.join(gitRoot, WORKTREES_DIR);
  const worktreePath = path.join(worktreesDir, alias);

  try {
    // Ensure worktrees directory exists
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
      log.info(LOG.TOOL, `Created worktrees directory`, { worktreesDir });
    }

    // Check if worktree already exists (cleanup from previous run)
    if (fs.existsSync(worktreePath)) {
      log.warn(LOG.TOOL, `Worktree already exists, removing first`, {
        worktreePath,
      });
      // Use -f -f to force remove even if locked
      await execAsync(`git worktree remove "${worktreePath}" -f -f`, {
        cwd: gitRoot,
      });
    }

    // Create detached worktree from HEAD
    await execAsync(`git worktree add "${worktreePath}" HEAD --detach`, {
      cwd: gitRoot,
    });

    log.info(LOG.TOOL, `Created worktree`, { alias, worktreePath });
    return worktreePath;
  } catch (e) {
    log.error(LOG.TOOL, `Failed to create worktree`, {
      alias,
      worktreePath,
      error: String(e),
    });
    return null;
  }
}

/**
 * Remove a git worktree
 */
export async function removeAgentWorktree(worktreePath: string): Promise<void> {
  try {
    // Get git root from the worktree path
    const gitRoot = await getGitRoot(worktreePath);
    if (!gitRoot) {
      // Worktree might already be removed, just clean up the directory
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      return;
    }

    await execAsync(`git worktree remove "${worktreePath}" --force`, {
      cwd: gitRoot,
    });
    log.info(LOG.TOOL, `Removed worktree`, { worktreePath });
  } catch (e) {
    log.warn(LOG.TOOL, `Failed to remove worktree (may already be gone)`, {
      worktreePath,
      error: String(e),
    });
    // Try to clean up directory anyway
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // Ignore
    }
  }
}
