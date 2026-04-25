/**
 * GSD Quick Mode — /gsd quick <task>
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 *
 * Lightweight task execution with GSD guarantees (atomic commits, state
 * tracking) but without the full milestone/slice ceremony.
 *
 * Quick tasks live in `.gsd/quick/` and are tracked in STATE.md's
 * "Quick Tasks Completed" table.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { GitServiceImpl, runGit } from "./git-service.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { nativeHasStagedChanges } from "./native-git-bridge.js";

interface QuickReturnState {
  basePath: string;
  originalBranch: string;
  quickBranch: string;
  taskNum: number;
  slug: string;
  description: string;
}

let pendingQuickReturn: QuickReturnState | null = null;

// ─── Quick Task Helpers ───────────────────────────────────────────────────────

/**
 * Generate a URL-friendly slug from a description.
 * Lowercase, hyphens, max 40 chars.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

/**
 * Determine the next quick task number by scanning existing directories.
 */
function getNextTaskNum(quickDir: string): number {
  if (!existsSync(quickDir)) return 1;
  try {
    const entries = readdirSync(quickDir, { withFileTypes: true });
    let max = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(\d+)-/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * Ensure the quick task directory structure exists.
 * Returns the task directory path.
 */
function ensureQuickDir(basePath: string, taskNum: number, slug: string): string {
  const quickDir = join(gsdRoot(basePath), "quick");
  const taskDir = join(quickDir, `${taskNum}-${slug}`);
  mkdirSync(taskDir, { recursive: true });
  return taskDir;
}

function quickReturnStatePath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "quick-return.json");
}

function persistPendingReturn(state: QuickReturnState): void {
  pendingQuickReturn = state;
  mkdirSync(join(gsdRoot(state.basePath), "runtime"), { recursive: true });
  writeFileSync(quickReturnStatePath(state.basePath), JSON.stringify(state) + "\n", "utf-8");
}

function readPendingReturn(basePath: string): QuickReturnState | null {
  if (pendingQuickReturn && pendingQuickReturn.basePath === basePath) {
    return pendingQuickReturn;
  }

  try {
    const raw = readFileSync(quickReturnStatePath(basePath), "utf-8");
    const parsed = JSON.parse(raw) as Partial<QuickReturnState>;
    if (
      typeof parsed.basePath === "string"
      && typeof parsed.originalBranch === "string"
      && typeof parsed.quickBranch === "string"
      && typeof parsed.taskNum === "number"
      && typeof parsed.slug === "string"
      && typeof parsed.description === "string"
    ) {
      pendingQuickReturn = parsed as QuickReturnState;
      return pendingQuickReturn;
    }
  } catch {
    // No persisted quick-return state
  }

  return null;
}

function clearPendingReturn(basePath: string): void {
  if (pendingQuickReturn?.basePath === basePath) {
    pendingQuickReturn = null;
  }
  rmSync(quickReturnStatePath(basePath), { force: true });
}

function hasStagedChanges(basePath: string): boolean {
  return nativeHasStagedChanges(basePath);
}

export function cleanupQuickBranch(basePath = process.cwd()): boolean {
  const state = readPendingReturn(basePath);
  if (!state) return false;

  const repoPath = state.basePath;
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const git = new GitServiceImpl(repoPath, gitPrefs);

  if (git.getCurrentBranch() === state.quickBranch) {
    try {
      git.autoCommit("quick-task", `Q${state.taskNum}`, []);
    } catch {
      // Best-effort: quick work may already be committed.
    }
  }

  if (git.getCurrentBranch() !== state.originalBranch) {
    runGit(repoPath, ["checkout", state.originalBranch]);
  }

  runGit(repoPath, ["merge", "--squash", state.quickBranch]);

  if (hasStagedChanges(repoPath)) {
    runGit(repoPath, ["commit", "-m", `quick(Q${state.taskNum}): ${state.slug}`]);
  }

  runGit(repoPath, ["branch", "-D", state.quickBranch], { allowFailure: true });
  clearPendingReturn(repoPath);
  return true;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleQuick(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const root = gsdRoot(basePath);

  // Validate: .gsd/ must exist
  if (!existsSync(root)) {
    ctx.ui.notify(
      "No .gsd/ directory found. Run /gsd to initialize a project first.",
      "error",
    );
    return;
  }

  // Parse description from args
  let description = args.trim();
  if (!description) {
    ctx.ui.notify(
      "Usage: /gsd quick <task description>\n\nExample: /gsd quick fix login button not responding on mobile",
      "info",
    );
    return;
  }

  // Setup
  const quickDir = join(root, "quick");
  const taskNum = getNextTaskNum(quickDir);
  const slug = slugify(description);
  const taskDir = ensureQuickDir(basePath, taskNum, slug);
  const taskDirRel = `.gsd/quick/${taskNum}-${slug}`;
  const date = new Date().toISOString().split("T")[0];

  // Create git branch for the quick task (unless isolation:none — #3337)
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const git = new GitServiceImpl(basePath, gitPrefs);
  const branchName = `gsd/quick/${taskNum}-${slug}`;
  let originalBranch = git.getCurrentBranch();

  const { getIsolationMode } = await import("./preferences.js");
  const usesBranch = getIsolationMode() !== "none";

  let branchCreated = false;
  if (usesBranch) {
    try {
      const current = originalBranch;
      if (current !== branchName) {
        // Auto-commit any dirty state before switching
        try {
          git.autoCommit("quick-task", `Q${taskNum}`, []);
        } catch { /* nothing to commit — fine */ }

        runGit(basePath, ["checkout", "-b", branchName]);
        branchCreated = true;
      }
    } catch (err) {
      // Branch creation failed — continue on current branch
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not create branch ${branchName}: ${message}. Working on current branch.`, "warning");
    }
  }

  const actualBranch = branchCreated ? branchName : git.getCurrentBranch();
  if (actualBranch === branchName && originalBranch !== branchName) {
    persistPendingReturn({
      basePath,
      originalBranch,
      quickBranch: branchName,
      taskNum,
      slug,
      description,
    });
  }

  // Notify user
  ctx.ui.notify(
    `Quick task ${taskNum}: ${description}\nDirectory: ${taskDirRel}\nBranch: ${actualBranch}`,
    "info",
  );

  // Build and dispatch the quick task prompt
  const summaryPath = `${taskDirRel}/${taskNum}-SUMMARY.md`;
  const prompt = loadPrompt("quick-task", {
    description,
    taskDir: taskDirRel,
    branch: actualBranch,
    summaryPath,
    date,
    taskNum: String(taskNum),
    slug,
  });

  pi.sendMessage(
    {
      customType: "gsd-quick-task",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}
