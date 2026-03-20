/**
 * Worktree ↔ project root state synchronization for auto-mode.
 *
 * When auto-mode runs inside a worktree, dispatch-critical state files
 * (.gsd/ metadata) diverge between the worktree (where work happens)
 * and the project root (where startAutoMode reads initial state on restart).
 * Without syncing, restarting auto-mode reads stale state from the project
 * root and re-dispatches already-completed units.
 *
 * Also contains resource staleness detection and stale worktree escape.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  cpSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { safeCopy, safeCopyRecursive } from "./safe-fs.js";

// ─── Project Root → Worktree Sync ─────────────────────────────────────────

/**
 * Sync milestone artifacts from project root INTO worktree before deriveState.
 * Covers the case where the LLM wrote artifacts to the main repo filesystem
 * (e.g. via absolute paths) but the worktree has stale data. Also deletes
 * gsd.db in the worktree so it rebuilds from fresh disk state (#853).
 * Non-fatal — sync failure should never block dispatch.
 */
export function syncProjectRootToWorktree(
  projectRoot: string,
  worktreePath: string,
  milestoneId: string | null,
): void {
  if (!worktreePath || !projectRoot || worktreePath === projectRoot) return;
  if (!milestoneId) return;

  const prGsd = join(projectRoot, ".gsd");
  const wtGsd = join(worktreePath, ".gsd");

  // Copy milestone directory from project root to worktree if the project root
  // has newer artifacts (e.g. slices that don't exist in the worktree yet)
  safeCopyRecursive(
    join(prGsd, "milestones", milestoneId),
    join(wtGsd, "milestones", milestoneId),
  );

  // Delete worktree gsd.db so it rebuilds from the freshly synced files.
  // Stale DB rows are the root cause of the infinite skip loop (#853).
  try {
    const wtDb = join(wtGsd, "gsd.db");
    if (existsSync(wtDb)) {
      unlinkSync(wtDb);
    }
  } catch {
    /* non-fatal */
  }
}

// ─── Worktree → Project Root Sync ─────────────────────────────────────────

/**
 * Sync dispatch-critical .gsd/ state files from worktree to project root.
 * Only runs when inside an auto-worktree (worktreePath differs from projectRoot).
 * Copies: STATE.md + active milestone directory (roadmap, slice plans, task summaries).
 * Non-fatal — sync failure should never block dispatch.
 */
export function syncStateToProjectRoot(
  worktreePath: string,
  projectRoot: string,
  milestoneId: string | null,
): void {
  if (!worktreePath || !projectRoot || worktreePath === projectRoot) return;
  if (!milestoneId) return;

  const wtGsd = join(worktreePath, ".gsd");
  const prGsd = join(projectRoot, ".gsd");

  // 1. STATE.md — the quick-glance status used by initial deriveState()
  safeCopy(join(wtGsd, "STATE.md"), join(prGsd, "STATE.md"), { force: true });

  // 2. Milestone directory — ROADMAP, slice PLANs, task summaries
  // Copy the entire milestone .gsd subtree so deriveState reads current checkboxes
  safeCopyRecursive(
    join(wtGsd, "milestones", milestoneId),
    join(prGsd, "milestones", milestoneId),
    { force: true },
  );

  // 4. Runtime records — unit dispatch state used by selfHealRuntimeRecords().
  // Without this, a crash during a unit leaves the runtime record only in the
  // worktree. If the next session resolves basePath before worktree re-entry,
  // selfHeal can't find or clear the stale record (#769).
  safeCopyRecursive(
    join(wtGsd, "runtime", "units"),
    join(prGsd, "runtime", "units"),
    { force: true },
  );
}

// ─── Resource Staleness ───────────────────────────────────────────────────

/**
 * Read the resource version (semver) from the managed-resources manifest.
 * Uses gsdVersion instead of syncedAt so that launching a second session
 * doesn't falsely trigger staleness (#804).
 */
export function readResourceVersion(): string | null {
  const agentDir =
    process.env.GSD_CODING_AGENT_DIR || join(homedir(), ".gsd", "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.gsdVersion === "string"
      ? manifest.gsdVersion
      : null;
  } catch {
    return null;
  }
}

/**
 * Check if managed resources have been updated since session start.
 * Returns a warning message if stale, null otherwise.
 */
export function checkResourcesStale(
  versionOnStart: string | null,
): string | null {
  if (versionOnStart === null) return null;
  const current = readResourceVersion();
  if (current === null) return null;
  if (current !== versionOnStart) {
    return "GSD resources were updated since this session started. Restart gsd to load the new code.";
  }
  return null;
}

// ─── Stale Worktree Escape ────────────────────────────────────────────────

/**
 * Detect and escape a stale worktree cwd (#608).
 *
 * After milestone completion + merge, the worktree directory is removed but
 * the process cwd may still point inside `.gsd/worktrees/<MID>/`.
 * When a new session starts, `process.cwd()` is passed as `base` to startAuto
 * and all subsequent writes land in the wrong directory. This function detects
 * that scenario and chdir back to the project root.
 *
 * Returns the corrected base path.
 */
export function escapeStaleWorktree(base: string): string {
  // Direct layout: /.gsd/worktrees/
  const directMarker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
  let idx = base.indexOf(directMarker);
  if (idx === -1) {
    // Symlink-resolved layout: /.gsd/projects/<hash>/worktrees/
    const symlinkRe = new RegExp(
      `\\${pathSep}\\.gsd\\${pathSep}projects\\${pathSep}[a-f0-9]+\\${pathSep}worktrees\\${pathSep}`,
    );
    const match = base.match(symlinkRe);
    if (!match || match.index === undefined) return base;
    idx = match.index;
  }

  // base is inside .gsd/worktrees/<something> — extract the project root
  const projectRoot = base.slice(0, idx);
  try {
    process.chdir(projectRoot);
  } catch {
    // If chdir fails, return the original — caller will handle errors downstream
    return base;
  }
  return projectRoot;
}

/**
 * Clean stale runtime unit files for completed milestones.
 *
 * After restart, stale runtime/units/*.json from prior milestones can
 * cause deriveState to resume the wrong milestone (#887). Removes files
 * for milestones that have a SUMMARY (fully complete).
 */
export function cleanStaleRuntimeUnits(
  gsdRootPath: string,
  hasMilestoneSummary: (mid: string) => boolean,
): number {
  const runtimeUnitsDir = join(gsdRootPath, "runtime", "units");
  if (!existsSync(runtimeUnitsDir)) return 0;

  let cleaned = 0;
  try {
    for (const file of readdirSync(runtimeUnitsDir)) {
      if (!file.endsWith(".json")) continue;
      const midMatch = file.match(/(M\d+(?:-[a-z0-9]{6})?)/);
      if (!midMatch) continue;
      if (hasMilestoneSummary(midMatch[1])) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch {
          /* non-fatal */
        }
      }
    }
  } catch {
    /* non-fatal */
  }
  return cleaned;
}
