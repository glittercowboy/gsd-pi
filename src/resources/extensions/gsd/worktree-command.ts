/**
 * GSD Worktree Command — /worktree
 *
 * Create, list, merge, and remove git worktrees under .gsd/worktrees/.
 *
 * Usage:
 *   /worktree <name>        — create a new worktree
 *   /worktree list          — list existing worktrees
 *   /worktree merge [name] [target] — start LLM-guided merge (auto-detects when inside a worktree)
 *   /worktree remove <name> — remove a worktree and its branch
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { loadPrompt } from "./prompt-loader.js";
import { autoCommitCurrentBranch } from "./worktree.js";
import { runWorktreePostCreateHook } from "./auto-worktree.js";
import { showConfirm } from "../shared/confirm-ui.js";
import { gsdRoot, milestonesDir } from "./paths.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  mergeWorktreeToMain,
  diffWorktreeAll,
  diffWorktreeNumstat,
  getMainBranch,
  getWorktreeGSDDiff,
  getWorktreeCodeDiff,
  getWorktreeLog,
  worktreeBranchName,
  worktreePath,
} from "./worktree-manager.js";
import { inferCommitType } from "./git-service.js";
import type { FileLineStat } from "./worktree-manager.js";
import { existsSync, realpathSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { nativeMergeAbort } from "./native-git-bridge.js";
import { join, resolve, sep } from "node:path";

/**
 * Tracks the original project root so we can switch back.
 * Set when we first chdir into a worktree, cleared on return.
 */
let originalCwd: string | null = null;

/** Get the original project root if currently in a worktree, or null. */
export function getWorktreeOriginalCwd(): string | null {
  return originalCwd;
}

/**
 * Resolve the git HEAD file path for a given directory.
 * Handles both normal repos (.git is a directory) and worktrees (.git is a file).
 */
function resolveGitHeadPath(dir: string): string | null {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) return null;

  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (content.startsWith("gitdir: ")) {
      // Worktree — .git is a file pointing to the real gitdir
      const gitDir = resolve(dir, content.slice(8));
      const headPath = join(gitDir, "HEAD");
      return existsSync(headPath) ? headPath : null;
    }
    // Normal repo — .git is a directory
    const headPath = join(dir, ".git", "HEAD");
    return existsSync(headPath) ? headPath : null;
  } catch {
    return null;
  }
}

/**
 * Nudge pi's FooterDataProvider to re-read the git branch.
 *
 * The footer caches the branch and watches a single .git dir for changes.
 * After process.chdir() into a worktree (or back), the watcher is stale —
 * it's still watching the old git dir. We touch HEAD in both the old and
 * new git dirs to ensure the watcher fires regardless of which one it's
 * monitoring. This clears cachedBranch; the next getGitBranch() call uses
 * the new process.cwd() and picks up the correct branch.
 */
function nudgeGitBranchCache(previousCwd: string): void {
  const now = new Date();
  for (const dir of [previousCwd, process.cwd()]) {
    try {
      const headPath = resolveGitHeadPath(dir);
      if (headPath) utimesSync(headPath, now, now);
    } catch {
      // Best-effort — branch display may be stale
    }
  }
}

/** Get the name of the active worktree, or null if not in one. */
export function getActiveWorktreeName(): string | null {
  if (!originalCwd) return null;
  const cwd = process.cwd();
  const wtDir = join(originalCwd, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return null;
  const rel = cwd.slice(wtDir.length + 1);
  const name = rel.split("/")[0] ?? rel.split("\\")[0];
  return name || null;
}

// ─── Shared completions and handler (used by both /worktree and /wt) ────────

function worktreeCompletions(prefix: string) {
  const parts = prefix.trim().split(/\s+/);
  const subcommands = ["list", "merge", "remove", "switch", "create", "return"];

  if (parts.length <= 1) {
    const partial = parts[0] ?? "";
    const cmdCompletions = subcommands
      .filter(cmd => cmd.startsWith(partial))
      .map(cmd => ({ value: cmd, label: cmd }));
    try {
      const mainBase = getWorktreeOriginalCwd() ?? process.cwd();
      const existing = listWorktrees(mainBase);
      const nameCompletions = existing
        .filter(wt => wt.name.startsWith(partial))
        .map(wt => ({ value: wt.name, label: wt.name }));
      return [...cmdCompletions, ...nameCompletions];
    } catch {
      return cmdCompletions;
    }
  }

  if ((parts[0] === "merge" || parts[0] === "remove" || parts[0] === "switch" || parts[0] === "create") && parts.length <= 2) {
    const namePrefix = parts[1] ?? "";
    try {
      const mainBase = getWorktreeOriginalCwd() ?? process.cwd();
      const existing = listWorktrees(mainBase);
      const nameCompletions = existing
        .filter(wt => wt.name.startsWith(namePrefix))
        .map(wt => ({ value: `${parts[0]} ${wt.name}`, label: wt.name }));

      // Add "all" option for remove
      if (parts[0] === "remove" && "all".startsWith(namePrefix)) {
        nameCompletions.push({ value: "remove all", label: "all" });
      }

      return nameCompletions;
    } catch {
      return [];
    }
  }

  return [];
}

async function worktreeHandler(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  alias: string,
): Promise<void> {
  const trimmed = (typeof args === "string" ? args : "").trim();
  const basePath = process.cwd();

  if (trimmed === "") {
    ctx.ui.notify(
      [
        "Usage:",
        `  /${alias} <name>        — create and switch into a new worktree`,
        `  /${alias} switch <name> — switch into an existing worktree`,
        `  /${alias} return        — switch back to the main project tree`,
        `  /${alias} list          — list all worktrees`,
        `  /${alias} merge [name] [target] — merge worktree into target branch (auto-detects when inside a worktree)`,
        `  /${alias} remove <name|all> — remove a worktree (or all) and its branch`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (trimmed === "list") {
    await handleList(basePath, ctx);
    return;
  }

  if (trimmed === "return") {
    await handleReturn(ctx);
    return;
  }

  if (trimmed.startsWith("switch ") || trimmed.startsWith("create ")) {
    const name = trimmed.replace(/^(?:switch|create)\s+/, "").trim();
    if (!name) {
      ctx.ui.notify(`Usage: /${alias} ${trimmed.split(" ")[0]} <name>`, "warning");
      return;
    }
    // create and switch both do the same thing: switch if exists, create if not
    const mainBase = originalCwd ?? basePath;
    const existing = listWorktrees(mainBase);
    if (existing.some(wt => wt.name === name)) {
      await handleSwitch(basePath, name, ctx);
    } else {
      await handleCreate(basePath, name, ctx);
    }
    return;
  }

  if (trimmed === "merge" || trimmed.startsWith("merge ")) {
    const mergeArgs = trimmed.replace(/^merge\s*/, "").trim().split(/\s+/).filter(Boolean);
    const mainBase = originalCwd ?? basePath;
    const activeWt = getActiveWorktreeName();

    if (mergeArgs.length === 0) {
      // Bare "/worktree merge" — only valid when inside a worktree
      if (!activeWt) {
        ctx.ui.notify(`Usage: /${alias} merge <name> [target]`, "warning");
        return;
      }
      await handleMerge(mainBase, activeWt, ctx, pi, undefined);
      return;
    }

    const name = mergeArgs[0]!;
    const targetBranch = mergeArgs[1];

    // Check if 'name' is an actual worktree
    const worktrees = listWorktrees(mainBase);
    const isWorktree = worktrees.some(w => w.name === name);

    if (isWorktree) {
      await handleMerge(mainBase, name, ctx, pi, targetBranch);
    } else if (activeWt) {
      // Not a worktree name — user is in a worktree and gave the target branch
      // e.g. "/worktree merge main" while inside worktree "new"
      await handleMerge(mainBase, activeWt, ctx, pi, name);
    } else {
      ctx.ui.notify(`Worktree "${name}" not found. Run /${alias} list to see available worktrees.`, "warning");
    }
    return;
  }

  if (trimmed === "remove" || trimmed.startsWith("remove ")) {
    const name = trimmed.replace(/^remove\s*/, "").trim();
    const mainBase = originalCwd ?? basePath;

    if (name === "all") {
      await handleRemoveAll(mainBase, ctx);
      return;
    }

    if (!name) {
      ctx.ui.notify(`Usage: /${alias} remove <name|all>`, "warning");
      return;
    }

    await handleRemove(mainBase, name, ctx);
    return;
  }

  const RESERVED = ["list", "return", "switch", "create", "merge", "remove"];
  if (RESERVED.includes(trimmed)) {
    ctx.ui.notify(`Usage: /${alias} ${trimmed}${trimmed === "list" || trimmed === "return" ? "" : " <name>"}`, "warning");
    return;
  }

  const mainBase = originalCwd ?? basePath;
  const nameOnly = trimmed.split(/\s+/)[0]!;
  if (trimmed !== nameOnly) {
    ctx.ui.notify(`Unknown command. Did you mean /${alias} switch ${nameOnly}?`, "warning");
    return;
  }

  const existing = listWorktrees(mainBase);
  if (existing.some(wt => wt.name === nameOnly)) {
    await handleSwitch(basePath, nameOnly, ctx);
  } else {
    await handleCreate(basePath, nameOnly, ctx);
  }
}

export function registerWorktreeCommand(pi: ExtensionAPI): void {
  // Restore worktree state after /reload.
  // The module-level originalCwd resets to null when extensions are re-loaded,
  // but process.cwd() is still inside the worktree. Detect this and recover.
  if (!originalCwd) {
    const cwd = process.cwd();
    const marker = `${sep}.gsd${sep}worktrees${sep}`;
    const markerIdx = cwd.indexOf(marker);
    if (markerIdx !== -1) {
      originalCwd = cwd.slice(0, markerIdx);
    }
  }

  pi.registerCommand("worktree", {
    description: "Git worktrees (also /wt): /worktree <name> | list | merge | remove",
    getArgumentCompletions: worktreeCompletions,

    async handler(args: string, ctx: ExtensionCommandContext) {
      await worktreeHandler(args, ctx, pi, "worktree");
    },
  });

  // /wt alias — same handler, same completions
  pi.registerCommand("wt", {
    description: "Alias for /worktree",
    getArgumentCompletions: worktreeCompletions,
    async handler(args: string, ctx: ExtensionCommandContext) {
      await worktreeHandler(args, ctx, pi, "wt");
    },
  });
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * Check if the worktree has existing GSD milestones that would
 * cause auto-mode to continue previous work instead of starting fresh.
 */
function hasExistingMilestones(wtPath: string): boolean {
  const mDir = milestonesDir(wtPath);
  if (!existsSync(mDir)) return false;
  try {
    const entries = readdirSync(mDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^M\d+(?:-[a-z0-9]{6})?/.test(d.name));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clear GSD planning artifacts so auto-mode starts fresh with the discuss flow.
 * Keeps the .gsd/ directory structure intact but removes milestones and root planning files.
 */
function clearGSDPlans(wtPath: string): void {
  const mDir = milestonesDir(wtPath);
  if (existsSync(mDir)) {
    rmSync(mDir, { recursive: true, force: true });
  }

  // Remove root planning files — PROJECT.md, DECISIONS.md, QUEUE.md, REQUIREMENTS.md
  // Keep STATE.md (gitignored, will be rebuilt) and other runtime files
  const root = gsdRoot(wtPath);
  const planningFiles = ["PROJECT.md", "DECISIONS.md", "QUEUE.md", "REQUIREMENTS.md"];
  for (const file of planningFiles) {
    const filePath = join(root, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

async function handleCreate(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    // Auto-commit dirty files before leaving current workspace (must happen
    // before createWorktree so the new worktree forks from committed HEAD)
    const commitMsg = autoCommitCurrentBranch(basePath, "worktree-switch", name);

    // Create from the main tree, not from inside another worktree
    const mainBase = originalCwd ?? basePath;
    const info = createWorktree(mainBase, name);

    // Run user-configured post-create hook (#597) — e.g. copy .env, symlink assets
    const hookError = runWorktreePostCreateHook(mainBase, info.path);
    if (hookError) {
      ctx.ui.notify(hookError, "warning");
    }

    // Track original cwd before switching
    if (!originalCwd) originalCwd = basePath;

    const prevCwd = process.cwd();
    process.chdir(info.path);
    nudgeGitBranchCache(prevCwd);

    // If the worktree inherited existing milestones, ask whether to keep or clear them
    let clearedPlans = false;
    if (hasExistingMilestones(info.path)) {
      // confirmLabel = Continue (safe default, on the left / first)
      // declineLabel = Start fresh (destructive, on the right)
      const keepExisting = await showConfirm(ctx, {
        title: "Worktree Setup",
        message: [
          `This worktree inherited existing GSD milestones from the main branch.`,
          ``,
          `  Continue — keep milestones and pick up where main left off`,
          `  Start fresh — clear milestones so /gsd auto starts a new project`,
        ].join("\n"),
        confirmLabel: "Continue",
        declineLabel: "Start fresh",
      });
      if (!keepExisting) {
        clearGSDPlans(info.path);
        clearedPlans = true;
      }
    }

    const commitNote = commitMsg
      ? `  ${CLR.muted("Auto-committed on previous branch before switching.")}`
      : "";
    const freshNote = clearedPlans
      ? `  ${CLR.ok("✓")} Cleared milestones — ${CLR.hint("/gsd auto")} will start fresh.`
      : "";
    ctx.ui.notify(
      [
        `${CLR.ok("✓")} Worktree ${CLR.name(name)} created and activated.`,
        "",
        `  ${CLR.label("path")}     ${CLR.path(info.path)}`,
        `  ${CLR.label("branch")}   ${CLR.branch(info.branch)}`,
        commitNote,
        freshNote,
        "",
        `  ${CLR.hint(`/worktree merge ${name}`)}  ${CLR.muted("merge back when done")}`,
        `  ${CLR.hint("/worktree return")}${" ".repeat(Math.max(1, name.length - 2))}  ${CLR.muted("switch back to main tree")}`,
      ].filter(Boolean).join("\n"),
      "info",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
  }
}

async function handleSwitch(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;
    const wtPath = worktreePath(mainBase, name);

    if (!existsSync(wtPath)) {
      ctx.ui.notify(
        `Worktree "${name}" not found. Run /worktree list to see available worktrees.`,
        "warning",
      );
      return;
    }

    // Auto-commit dirty files before leaving current workspace
    const commitMsg = autoCommitCurrentBranch(basePath, "worktree-switch", name);

    // Track original cwd before switching
    if (!originalCwd) originalCwd = basePath;

    const prevCwd = process.cwd();
    process.chdir(wtPath);
    nudgeGitBranchCache(prevCwd);

    const commitNote = commitMsg
      ? `  ${CLR.muted("Auto-committed on previous branch before switching.")}`
      : "";
    ctx.ui.notify(
      [
        `${CLR.ok("✓")} Switched to worktree ${CLR.name(name)}.`,
        "",
        `  ${CLR.label("path")}     ${CLR.path(wtPath)}`,
        `  ${CLR.label("branch")}   ${CLR.branch(worktreeBranchName(name))}`,
        commitNote,
        "",
        `  ${CLR.hint("/worktree return")}  ${CLR.muted("switch back to main tree")}`,
      ].filter(Boolean).join("\n"),
      "info",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to switch to worktree: ${msg}`, "error");
  }
}

async function handleReturn(ctx: ExtensionCommandContext): Promise<void> {
  if (!originalCwd) {
    ctx.ui.notify("Already in the main project tree.", "info");
    return;
  }

  // Auto-commit dirty files before leaving worktree
  const commitMsg = autoCommitCurrentBranch(process.cwd(), "worktree-return", "worktree");

  const returnTo = originalCwd;
  originalCwd = null;

  const prevCwd = process.cwd();
  process.chdir(returnTo);
  nudgeGitBranchCache(prevCwd);

  const commitNote = commitMsg
    ? `  ${CLR.muted("Auto-committed on worktree branch before returning.")}`
    : "";
  ctx.ui.notify(
    [
      `${CLR.ok("✓")} Returned to main project tree.`,
      "",
      `  ${CLR.label("path")}  ${CLR.path(returnTo)}`,
      commitNote,
    ].filter(Boolean).join("\n"),
    "info",
  );
}

// ─── ANSI styling ─────────────────────────────────────────────────────────
// Consistent palette for all worktree command output.

const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const WHITE  = "\x1b[37m";
const MAGENTA = "\x1b[35m";

// Semantic aliases for consistent use across all handlers
const CLR = {
  /** Worktree names and primary emphasis */
  name:    (s: string) => `${BOLD}${CYAN}${s}${RESET}`,
  /** Active worktree name */
  nameActive: (s: string) => `${BOLD}${GREEN}${s}${RESET}`,
  /** Branch names */
  branch:  (s: string) => `${MAGENTA}${s}${RESET}`,
  /** File paths */
  path:    (s: string) => `${DIM}${s}${RESET}`,
  /** Labels (key in key:value pairs) */
  label:   (s: string) => `${WHITE}${s}${RESET}`,
  /** Hints and commands the user can run */
  hint:    (s: string) => `${DIM}${CYAN}${s}${RESET}`,
  /** Success messages and checks */
  ok:      (s: string) => `${GREEN}${s}${RESET}`,
  /** Warning badges */
  warn:    (s: string) => `${YELLOW}${s}${RESET}`,
  /** Section headers */
  header:  (s: string) => `${BOLD}${WHITE}${s}${RESET}`,
  /** Muted secondary info */
  muted:   (s: string) => `${DIM}${s}${RESET}`,
} as const;

async function handleList(
  basePath: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;
    const worktrees = listWorktrees(mainBase);

    if (worktrees.length === 0) {
      ctx.ui.notify("No GSD worktrees found. Create one with /worktree <name>.", "info");
      return;
    }

    const cwd = process.cwd();
    const lines = [CLR.header("GSD Worktrees"), ""];
    for (const wt of worktrees) {
      const isCurrent = cwd === wt.path
        || (existsSync(cwd) && existsSync(wt.path)
          && realpathSync(cwd) === realpathSync(wt.path));

      const styledName = isCurrent ? CLR.nameActive(wt.name) : CLR.name(wt.name);
      const badge = isCurrent
        ? `  ${CLR.ok("● active")}`
        : !wt.exists
          ? `  ${CLR.warn("✗ missing")}`
          : "";
      lines.push(`  ${styledName}${badge}`);
      lines.push(`    ${CLR.label("branch")}  ${CLR.branch(wt.branch)}`);
      lines.push(`    ${CLR.label("path")}    ${CLR.path(wt.path)}`);
      lines.push("");
    }

    if (originalCwd) {
      lines.push(`  ${CLR.label("main tree")}  ${CLR.path(originalCwd)}`);
    }

    ctx.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to list worktrees: ${msg}`, "error");
  }
}

async function handleMerge(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  targetBranch?: string,
): Promise<void> {
  try {
    const branch = worktreeBranchName(name);
    const mainBranch = targetBranch ?? getMainBranch(basePath);

    // Validate the worktree/branch exists
    const worktrees = listWorktrees(basePath);
    const wt = worktrees.find(w => w.name === name);
    if (!wt) {
      ctx.ui.notify(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`, "warning");
      return;
    }

    // Gather merge context — full repo diff, not just .gsd/
    const diffSummary = diffWorktreeAll(basePath, name);
    const numstat = diffWorktreeNumstat(basePath, name);
    const gsdDiff = getWorktreeGSDDiff(basePath, name);
    const codeDiff = getWorktreeCodeDiff(basePath, name);
    const commitLog = getWorktreeLog(basePath, name);

    const totalChanges = diffSummary.added.length + diffSummary.modified.length + diffSummary.removed.length;
    if (totalChanges === 0 && !commitLog.trim()) {
      ctx.ui.notify(`Worktree ${CLR.name(name)} has no changes to merge.`, "info");
      return;
    }

    // Build a map of file → line stats for the preview
    const statMap = new Map<string, FileLineStat>();
    for (const s of numstat) statMap.set(s.file, s);

    // Compute totals
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const s of numstat) { totalAdded += s.added; totalRemoved += s.removed; }

    // Split files into code vs GSD for the preview
    const isGSD = (f: string) => f.startsWith(".gsd/");
    const codeChanges = diffSummary.added.filter(f => !isGSD(f)).length
      + diffSummary.modified.filter(f => !isGSD(f)).length
      + diffSummary.removed.filter(f => !isGSD(f)).length;
    const gsdChanges = diffSummary.added.filter(isGSD).length
      + diffSummary.modified.filter(isGSD).length
      + diffSummary.removed.filter(isGSD).length;

    // Format a file line with +/- stats
    const formatFileLine = (prefix: string, file: string): string => {
      const s = statMap.get(file);
      const stat = s ? ` ${CLR.ok(`+${s.added}`)} ${RED}-${s.removed}${RESET}` : "";
      return `    ${prefix} ${file}${stat}`;
    };

    // Preview confirmation before merge dispatch
    const previewLines = [
      `Merge ${CLR.name(name)} → ${CLR.branch(mainBranch)}`,
      "",
      `  ${totalChanges} file${totalChanges === 1 ? "" : "s"} changed, ${CLR.ok(`+${totalAdded}`)} ${RED}-${totalRemoved}${RESET} lines ${CLR.muted(`(${codeChanges} code, ${gsdChanges} GSD)`)}`,
    ];

    const appendFileList = (label: string, files: string[], prefix: string, limit = 10) => {
      if (files.length === 0) return;
      previewLines.push("", `  ${label}:`);
      for (const f of files.slice(0, limit)) previewLines.push(formatFileLine(prefix, f));
      if (files.length > limit) previewLines.push(`    … and ${files.length - limit} more`);
    };

    appendFileList("Added", diffSummary.added, "+");
    appendFileList("Modified", diffSummary.modified, "~");
    appendFileList("Removed", diffSummary.removed, "-");

    const confirmed = await showConfirm(ctx, {
      title: "Worktree Merge",
      message: previewLines.join("\n"),
      confirmLabel: "Merge",
      declineLabel: "Cancel",
    });
    if (!confirmed) {
      ctx.ui.notify("Merge cancelled.", "info");
      return;
    }

    // Switch to the main tree before merging.
    // Must be on the main branch to run git merge --squash.
    if (originalCwd) {
      const prevCwd = process.cwd();
      process.chdir(basePath);
      nudgeGitBranchCache(prevCwd);
      originalCwd = null;
    }

    // --- Deterministic merge path (preferred) ---
    // Try a direct squash-merge first. Only fall back to LLM on conflict.
    const commitType = inferCommitType(name);
    const commitMessage = `${commitType}(${name}): merge worktree ${name}`;

    // Reconcile worktree DB into main DB before squash merge
    const wtDbPath = join(worktreePath(basePath, name), ".gsd", "gsd.db");
    const mainDbPath = join(basePath, ".gsd", "gsd.db");
    if (existsSync(wtDbPath) && existsSync(mainDbPath)) {
      try {
        const { reconcileWorktreeDb } = await import("./gsd-db.js");
        reconcileWorktreeDb(mainDbPath, wtDbPath);
      } catch { /* non-fatal */ }
    }

    try {
      mergeWorktreeToMain(basePath, name, commitMessage);
      ctx.ui.notify(
        [
          `${CLR.ok("✓")} Merged ${CLR.name(name)} → ${CLR.branch(mainBranch)} ${CLR.muted("(deterministic squash)")}`,
          "",
          `  ${totalChanges} file${totalChanges === 1 ? "" : "s"} changed, ${CLR.ok(`+${totalAdded}`)} ${RED}-${totalRemoved}${RESET} lines`,
          `  ${CLR.muted("commit:")} ${commitMessage}`,
        ].join("\n"),
        "info",
      );
      return;
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      const isConflict = /conflict/i.test(mergeMsg);

      if (isConflict) {
        // Abort the failed merge so the working tree is clean for LLM retry
        try {
          nativeMergeAbort(basePath);
        } catch { /* already clean */ }

        ctx.ui.notify(
          `${CLR.muted("Deterministic merge hit conflicts — falling back to LLM-guided merge.")}`,
          "warning",
        );
        // Fall through to LLM dispatch below
      } else {
        // Non-conflict error — surface it directly, don't fall back
        ctx.ui.notify(`Failed to merge: ${mergeMsg}`, "error");
        return;
      }
    }

    // --- LLM fallback path (conflict resolution) ---
    // Format file lists for the prompt
    const formatFiles = (files: string[]) =>
      files.length > 0 ? files.map(f => `- \`${f}\``).join("\n") : "_(none)_";

    // Load and populate the merge prompt
    const wtPath = worktreePath(basePath, name);
    const prompt = loadPrompt("worktree-merge", {
      worktreeName: name,
      worktreeBranch: branch,
      mainBranch,
      mainTreePath: basePath,
      worktreePath: wtPath,
      commitLog: commitLog || "(no commits)",
      addedFiles: formatFiles(diffSummary.added),
      modifiedFiles: formatFiles(diffSummary.modified),
      removedFiles: formatFiles(diffSummary.removed),
      gsdDiff: gsdDiff || "(no GSD artifact changes)",
      codeDiff: codeDiff || "(no code changes)",
    });

    // Dispatch to the LLM
    pi.sendMessage(
      {
        customType: "gsd-worktree-merge",
        content: prompt,
        display: false,
      },
      { triggerTurn: true },
    );

    ctx.ui.notify(
      `${CLR.ok("✓")} Merge helper started for ${CLR.name(name)} ${CLR.muted(`(${codeChanges} code + ${gsdChanges} GSD artifact change${totalChanges === 1 ? "" : "s"})`)}`,
      "info",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to start merge: ${msg}`, "error");
  }
}

async function handleRemove(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;

    // Validate the worktree exists before attempting removal
    const worktrees = listWorktrees(mainBase);
    const wt = worktrees.find(w => w.name === name);
    if (!wt) {
      ctx.ui.notify(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`, "warning");
      return;
    }

    const confirmed = await showConfirm(ctx, {
      title: "Remove Worktree",
      message: `Remove worktree ${CLR.name(name)} and delete branch ${CLR.branch(wt.branch)}?`,
      confirmLabel: "Remove",
      declineLabel: "Cancel",
    });
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }

    const prevCwd = process.cwd();
    removeWorktree(mainBase, name, { deleteBranch: true });

    // If we were in that worktree, removeWorktree chdir'd us out — clear tracking
    if (originalCwd && process.cwd() !== prevCwd) {
      nudgeGitBranchCache(prevCwd);
      originalCwd = null;
    }

    ctx.ui.notify(`${CLR.ok("✓")} Worktree ${CLR.name(name)} removed ${CLR.muted("(branch deleted)")}.`, "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to remove worktree: ${msg}`, "error");
  }
}

async function handleRemoveAll(
  basePath: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;
    const worktrees = listWorktrees(mainBase);

    if (worktrees.length === 0) {
      ctx.ui.notify("No worktrees to remove.", "info");
      return;
    }

    const names = worktrees.map(w => w.name);
    const confirmed = await showConfirm(ctx, {
      title: "Remove All Worktrees",
      message: `Remove ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"} and delete their branches?\n\n${names.map(n => `  • ${CLR.name(n)}`).join("\n")}`,
      confirmLabel: "Remove all",
      declineLabel: "Cancel",
    });
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }

    const prevCwd = process.cwd();
    const removed: string[] = [];
    const failed: string[] = [];

    for (const wt of worktrees) {
      try {
        removeWorktree(mainBase, wt.name, { deleteBranch: true });
        removed.push(wt.name);
      } catch {
        failed.push(wt.name);
      }
    }

    // If we were in a worktree that got removed, clear tracking
    if (originalCwd && process.cwd() !== prevCwd) {
      nudgeGitBranchCache(prevCwd);
      originalCwd = null;
    }

    const lines: string[] = [];
    if (removed.length > 0) lines.push(`${CLR.ok("✓")} Removed: ${removed.map(n => CLR.name(n)).join(", ")}`);
    if (failed.length > 0) lines.push(`${CLR.warn("✗")} Failed: ${failed.map(n => CLR.name(n)).join(", ")}`);
    ctx.ui.notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to remove worktrees: ${msg}`, "error");
  }
}
