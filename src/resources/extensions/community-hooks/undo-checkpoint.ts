// GSD Community Hooks — Undo Checkpoint
//
// Automatically creates a git stash snapshot before each agent run, giving you
// an easy rollback point. Only creates checkpoints when there are uncommitted
// changes that could be lost.

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

function gitExec(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000 }, (error, stdout) => {
      resolve({
        stdout: stdout?.toString().trim() ?? "",
        exitCode: error ? 1 : 0,
      });
    });
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await gitExec(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.exitCode === 0;
}

async function hasChanges(cwd: string): Promise<boolean> {
  // Check for staged or unstaged changes
  const status = await gitExec(["status", "--porcelain"], cwd);
  return status.stdout.length > 0;
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await gitExec(["branch", "--show-current"], cwd);
  return result.stdout || "detached";
}

async function getStashCount(cwd: string): Promise<number> {
  const result = await gitExec(["stash", "list"], cwd);
  if (!result.stdout) return 0;
  return result.stdout.split("\n").filter(Boolean).length;
}

export function registerUndoCheckpoint(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    const cwd = process.cwd();

    recordFire("undoCheckpoint");
    if (!(await isGitRepo(cwd))) return;
    if (!(await hasChanges(cwd))) return;

    const branch = await getCurrentBranch(cwd);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const message = `gsd-checkpoint/${branch}/${timestamp}`;

    // Create a stash that keeps the working directory intact
    // --keep-index preserves staged changes, -u includes untracked files
    const result = await gitExec(
      ["stash", "push", "--keep-index", "--include-untracked", "-m", message],
      cwd,
    );

    if (result.exitCode === 0) {
      // Immediately pop to restore the working state — the stash entry remains
      // in the reflog for recovery
      await gitExec(["stash", "pop", "--index"], cwd);

      const stashCount = await getStashCount(cwd);
      recordAction("undoCheckpoint", `Saved: ${message}`);
      ctx.ui.notify(
        `Checkpoint saved: ${message} (${stashCount} total stashes)`,
        "info",
      );

      // Clean up old checkpoints — keep only the last 20
      if (stashCount > 20) {
        const listResult = await gitExec(["stash", "list", "--format=%gd %s"], cwd);
        const stashes = listResult.stdout.split("\n").filter((l) => l.includes("gsd-checkpoint/"));
        // Drop oldest checkpoints beyond 20
        for (const stash of stashes.slice(20)) {
          const stashRef = stash.split(" ")[0];
          if (stashRef) await gitExec(["stash", "drop", stashRef], cwd);
        }
      }
    }
  });
}
