/**
 * GSD Auto-Worktree -- lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import {
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  statSync,
  lstatSync as lstatSyncFn,
} from "node:fs";
import { isAbsolute, join, sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { GSDError, GSD_IO_ERROR, GSD_GIT_ERROR } from "./errors.js";
import {
  reconcileWorktreeDb,
  isDbAvailable,
  getMilestone,
  getMilestoneSlices,
  closeDatabase,
  openDatabase,
  getDbPath,
} from "./gsd-db.js";
import { atomicWriteSync } from "./atomic-write.js";
import { execFileSync } from "node:child_process";
import { safeCopy, safeCopyRecursive } from "./safe-fs.js";
import { gsdRoot } from "./paths.js";
import {
  createWorktree,
  removeWorktree,
  resolveGitDir,
  worktreePath,
  isInsideWorktreesDir,
} from "./worktree-manager.js";
import {
  detectWorktreeName,
  resolveGitHeadPath,
  nudgeGitBranchCache,
} from "./worktree.js";
import { MergeConflictError, readIntegrationBranch, RUNTIME_EXCLUSION_PATHS } from "./git-service.js";
import { debugLog } from "./debug-logger.js";
import { logWarning, logError } from "./workflow-logger.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeWorkingTreeStatus,
  nativeAddAllWithExclusions,
  nativeCommit,
  nativeCheckoutBranch,
  nativeMergeSquash,
  nativeConflictFiles,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeRmForce,
  nativeBranchDelete,
  nativeBranchForceReset,
  nativeBranchExists,
  nativeDiffNumstat,
  nativeUpdateRef,
  nativeIsAncestor,
  nativeMergeAbort,
} from "./native-git-bridge.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
const PROJECT_PREFERENCES_FILE = "PREFERENCES.md";
const LEGACY_PROJECT_PREFERENCES_FILE = "preferences.md";

// ─── Shared Constants & Helpers ─────────────────────────────────────────────

/**
 * Root-level .gsd/ state files synced between worktree and project root.
 * Single source of truth — used by syncGsdStateToWorktree, syncWorktreeStateBack,
 * and the dispatch-level sync functions.
 */
const ROOT_STATE_FILES = [
  "DECISIONS.md",
  "REQUIREMENTS.md",
  "PROJECT.md",
  "KNOWLEDGE.md",
  "OVERRIDES.md",
  "QUEUE.md",
  "completed-units.json",
  "metrics.json",
  "mcp.json",
  // NOTE: project preferences are intentionally NOT in ROOT_STATE_FILES.
  // Forward-sync (main → worktree) is handled explicitly in syncGsdStateToWorktree().
  // Back-sync (worktree → main) must NEVER overwrite the project root's copy
  // because the project root is authoritative for preferences (#2684).
] as const;

/**
 * Check if two filesystem paths resolve to the same real location.
 * Returns false if either path cannot be resolved (e.g. doesn't exist).
 */
function isSamePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    logWarning("worktree", `isSamePath failed: ${(e as Error).message}`);
    return false;
  }
}

// ─── ASSESSMENT Force-Sync Helper (#2821) ─────────────────────────────────

/** Regex matching YAML frontmatter `verdict:` field. */
const VERDICT_RE = /verdict:\s*[\w-]+/i;

/**
 * Walk a milestone directory and force-overwrite ASSESSMENT files in the
 * destination when the source copy contains a `verdict:` field.
 *
 * This is the targeted fix for the UAT stuck-loop (#2821): the main
 * safeCopyRecursive uses force:false to protect worktree-authoritative
 * files (#1886), but ASSESSMENT files written by run-uat must be
 * forward-synced when the project root has a verdict. Without this,
 * the worktree retains a stale FAIL or missing ASSESSMENT and
 * checkNeedsRunUat re-dispatches run-uat indefinitely.
 *
 * Only overwrites when the source has a verdict — never clobbers a
 * worktree ASSESSMENT with a verdictless project-root copy.
 */
function forceOverwriteAssessmentsWithVerdict(
  srcMilestoneDir: string,
  dstMilestoneDir: string,
): void {
  if (!existsSync(srcMilestoneDir)) return;

  // Walk slices/<SID>/ looking for *-ASSESSMENT.md files
  const slicesDir = join(srcMilestoneDir, "slices");
  if (!existsSync(slicesDir)) return;

  try {
    for (const sliceEntry of readdirSync(slicesDir, { withFileTypes: true })) {
      if (!sliceEntry.isDirectory()) continue;
      const srcSliceDir = join(slicesDir, sliceEntry.name);
      const dstSliceDir = join(dstMilestoneDir, "slices", sliceEntry.name);

      try {
        for (const fileEntry of readdirSync(srcSliceDir, { withFileTypes: true })) {
          if (!fileEntry.isFile()) continue;
          if (!fileEntry.name.endsWith("-ASSESSMENT.md")) continue;

          const srcFile = join(srcSliceDir, fileEntry.name);
          try {
            const srcContent = readFileSync(srcFile, "utf-8");
            if (!VERDICT_RE.test(srcContent)) continue; // no verdict in source — skip

            // Source has a verdict — force-copy into worktree
            mkdirSync(dstSliceDir, { recursive: true });
            safeCopy(srcFile, join(dstSliceDir, fileEntry.name), { force: true });
          } catch (err) {
            /* non-fatal per file */
            logWarning("worktree", `assessment force-copy failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        /* non-fatal per slice */
        logWarning("worktree", `assessment slice scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    /* non-fatal */
    logWarning("worktree", `assessment sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Module State ──────────────────────────────────────────────────────────

/** Original project root before chdir into auto-worktree. */
let originalBase: string | null = null;

function clearProjectRootStateFiles(basePath: string, milestoneId: string): void {
  const gsdDir = gsdRoot(basePath);
  const transientFiles = [
    join(gsdDir, "STATE.md"),
    join(gsdDir, "auto.lock"),
    join(gsdDir, "milestones", milestoneId, `${milestoneId}-META.json`),
  ];

  for (const file of transientFiles) {
    try {
      unlinkSync(file);
    } catch (err) {
      // ENOENT is expected — file may not exist (#3597)
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logWarning("worktree", `file unlink failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Clean up entire synced milestone directory and runtime/units.
  // syncStateToProjectRoot() copies these into the project root during
  // execution.  If they remain as untracked files when we attempt
  // `git merge --squash`, git rejects the merge with "local changes would
  // be overwritten", causing silent data loss (#1738).
  const syncedDirs = [
    join(gsdDir, "milestones", milestoneId),
    join(gsdDir, "runtime", "units"),
  ];

  for (const dir of syncedDirs) {
    try {
      if (existsSync(dir)) {
        // Only remove files that are untracked by git — tracked files are
        // managed by the branch checkout and should not be deleted.
        const untrackedOutput = execFileSync(
          "git",
          ["ls-files", "--others", "--exclude-standard", dir],
          { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
        ).trim();
        if (untrackedOutput) {
          for (const f of untrackedOutput.split("\n").filter(Boolean)) {
            try {
              unlinkSync(join(basePath, f));
            } catch (err) {
              // ENOENT/EISDIR are expected for already-removed or directory entries (#3597)
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== "ENOENT" && code !== "EISDIR") {
                logWarning("worktree", `untracked file unlink failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      }
    } catch (err) {
      /* non-fatal — git command may fail if not in repo */
      logWarning("worktree", `untracked file cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Build Artifact Auto-Resolve ─────────────────────────────────────────────

/** Patterns for machine-generated build artifacts that can be safely
 * auto-resolved by accepting --theirs during merge. These files are
 * regenerable and never contain meaningful manual edits. */
export const SAFE_AUTO_RESOLVE_PATTERNS: RegExp[] = [
  /\.tsbuildinfo$/,
  /\.pyc$/,
  /\/__pycache__\//,
  /\.DS_Store$/,
  /\.map$/,
];

/** Returns true if the file path is safe to auto-resolve during merge.
 * Covers `.gsd/` state files and common build artifacts. */
export const isSafeToAutoResolve = (filePath: string): boolean =>
  filePath.startsWith(".gsd/") ||
  SAFE_AUTO_RESOLVE_PATTERNS.some((re) => re.test(filePath));

// ─── Dispatch-Level Sync (project root ↔ worktree) ──────────────────────────

/**
 * Sync milestone artifacts from project root INTO worktree before deriveState.
 * Covers the case where the LLM wrote artifacts to the main repo filesystem
 * (e.g. via absolute paths) but the worktree has stale data. Also deletes
 * gsd.db in the worktree so it rebuilds from fresh disk state (#853).
 * Non-fatal — sync failure should never block dispatch.
 */
export function syncProjectRootToWorktree(
  projectRoot: string,
  worktreePath_: string,
  milestoneId: string | null,
): void {
  if (!worktreePath_ || !projectRoot || worktreePath_ === projectRoot) return;
  if (!milestoneId) return;

  const prGsd = join(projectRoot, ".gsd");
  const wtGsd = join(worktreePath_, ".gsd");

  // When .gsd is a symlink to the same external directory in both locations,
  // cpSync rejects the copy because source === destination (ERR_FS_CP_EINVAL).
  // Compare realpaths and skip when they resolve to the same physical path (#2184).
  if (isSamePath(prGsd, wtGsd)) return;

  // Copy milestone directory from project root to worktree — additive only.
  // force:false prevents cpSync from overwriting existing worktree files.
  // Without this, worktree-authoritative files (e.g. VALIDATION.md written
  // by validate-milestone) get clobbered by stale project root copies,
  // causing an infinite re-validation loop (#1886).
  safeCopyRecursive(
    join(prGsd, "milestones", milestoneId),
    join(wtGsd, "milestones", milestoneId),
    { force: false },
  );

  // Force-sync ASSESSMENT files that have a verdict from project root (#2821).
  // The additive-only copy above preserves worktree-authoritative files, but
  // ASSESSMENT files are special: after run-uat writes a verdict and post-unit
  // syncs it to the project root, the worktree may retain a stale copy (e.g.
  // verdict:fail while the project root has verdict:pass from a retry). On
  // session resume the DB is rebuilt from disk, and if the stale ASSESSMENT
  // persists, checkNeedsRunUat finds no passing verdict → re-dispatches
  // run-uat indefinitely (stuck-loop ×9).
  forceOverwriteAssessmentsWithVerdict(
    join(prGsd, "milestones", milestoneId),
    join(wtGsd, "milestones", milestoneId),
  );

  // Forward-sync completed-units.json from project root to worktree.
  // Project root is authoritative for completion state after crash recovery;
  // without this, the worktree re-dispatches already-completed units (#1886).
  safeCopy(
    join(prGsd, "completed-units.json"),
    join(wtGsd, "completed-units.json"),
    { force: true },
  );

  // Delete worktree gsd.db ONLY if it is empty (0 bytes).
  // An empty DB is stale/corrupt and should be rebuilt (#853).
  // A non-empty DB was populated by gsd-migrate on respawn and must be
  // preserved — deleting it truncates the file to 0 bytes when
  // openDatabase re-creates it, causing "no such table" failures (#2815).
  try {
    const wtDb = join(wtGsd, "gsd.db");
    let deleteSidecars = false;
    if (existsSync(wtDb)) {
      const size = statSync(wtDb).size;
      if (size === 0) {
        unlinkSync(wtDb);
        deleteSidecars = true;
      }
    } else {
      // Main DB already missing — sidecars are orphaned from a previous
      // partial cleanup and must still be removed.
      deleteSidecars = true;
    }
    // Always clean up WAL/SHM sidecar files when the main DB was deleted
    // or is already missing. Orphaned WAL/SHM files cause SQLite WAL
    // recovery on next open, which triggers a CPU spin on Node 24's
    // node:sqlite DatabaseSync implementation (#2478).
    if (deleteSidecars) {
      for (const suffix of ["-wal", "-shm"]) {
        const f = wtDb + suffix;
        if (existsSync(f)) {
          unlinkSync(f);
        }
      }
    }
  } catch (err) {
    /* non-fatal */
    logWarning("worktree", `worktree DB cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sync dispatch-critical .gsd/ state files from worktree to project root.
 * Only runs when inside an auto-worktree (worktreePath differs from projectRoot).
 * Copies: STATE.md + active milestone directory (roadmap, slice plans, task summaries).
 * Non-fatal — sync failure should never block dispatch.
 */
export function syncStateToProjectRoot(
  worktreePath_: string,
  projectRoot: string,
  milestoneId: string | null,
): void {
  if (!worktreePath_ || !projectRoot || worktreePath_ === projectRoot) return;
  if (!milestoneId) return;

  const wtGsd = join(worktreePath_, ".gsd");
  const prGsd = join(projectRoot, ".gsd");

  // When .gsd is a symlink to the same external directory in both locations,
  // cpSync rejects the copy because source === destination (ERR_FS_CP_EINVAL).
  // Compare realpaths and skip when they resolve to the same physical path (#2184).
  if (isSamePath(wtGsd, prGsd)) return;

  // 1. STATE.md — the quick-glance status used by initial deriveState()
  safeCopy(join(wtGsd, "STATE.md"), join(prGsd, "STATE.md"), { force: true });

  // 2. Milestone directory — ROADMAP, slice PLANs, task summaries
  // Copy the entire milestone .gsd subtree so deriveState reads current checkboxes
  safeCopyRecursive(
    join(wtGsd, "milestones", milestoneId),
    join(prGsd, "milestones", milestoneId),
    { force: true },
  );

  // 3. metrics.json — session cost/token tracking (#2313).
  // Without this, metrics accumulated in the worktree are invisible from the
  // project root and never appear in the dashboard or skill-health reports.
  safeCopy(join(wtGsd, "metrics.json"), join(prGsd, "metrics.json"), { force: true });

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
    process.env.GSD_CODING_AGENT_DIR || join(gsdHome, "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.gsdVersion === "string"
      ? manifest.gsdVersion
      : null;
  } catch (e) {
    logWarning("worktree", `readResourceVersion failed: ${(e as Error).message}`);
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

  // Guard: If the candidate project root's .gsd IS the user-level ~/.gsd,
  // the string-slice heuristic matched the wrong /.gsd/ boundary. This happens
  // when .gsd is a symlink into ~/.gsd/projects/<hash> and process.cwd()
  // resolved through the symlink. Returning ~ would be catastrophic (#1676).
  const candidateGsd = join(projectRoot, ".gsd").replaceAll("\\", "/");
  const gsdHomePath = gsdHome.replaceAll("\\", "/");
  if (candidateGsd === gsdHomePath || candidateGsd.startsWith(gsdHomePath + "/")) {
    // Don't chdir to home — return base unchanged.
    // resolveProjectRoot() in worktree.ts has the full git-file-based recovery
    // and will be called by the caller (startAuto → projectRoot()).
    return base;
  }

  try {
    process.chdir(projectRoot);
  } catch (e) {
    // If chdir fails, return the original — caller will handle errors downstream
    logWarning("worktree", `escapeStaleWorktree chdir failed: ${(e as Error).message}`);
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
        } catch (err) {
          /* non-fatal */
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    /* non-fatal */
    logWarning("worktree", `stale runtime unit cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return cleaned;
}

// ─── Worktree ↔ Main Repo Sync (#1311) ──────────────────────────────────────

/**
 * Sync .gsd/ state from the main repo into the worktree.
 *
 * When .gsd/ is a symlink to the external state directory, both the main
 * repo and worktree share the same directory — no sync needed.
 *
 * When .gsd/ is a real directory (e.g., git-tracked or manage_gitignore:false),
 * the worktree has its own copy that may be stale. This function copies
 * missing milestones, CONTEXT, ROADMAP, DECISIONS, REQUIREMENTS, and
 * PROJECT files from the main repo's .gsd/ into the worktree's .gsd/.
 *
 * Only adds missing content — never overwrites existing files in the worktree
 * (the worktree's execution state is authoritative for in-progress work).
 */
export function syncGsdStateToWorktree(
  mainBasePath: string,
  worktreePath_: string,
): { synced: string[] } {
  const mainGsd = gsdRoot(mainBasePath);
  const wtGsd = gsdRoot(worktreePath_);
  const synced: string[] = [];

  // If both resolve to the same directory (symlink), no sync needed
  if (isSamePath(mainGsd, wtGsd)) return { synced };

  if (!existsSync(mainGsd) || !existsSync(wtGsd)) return { synced };

  // Sync root-level .gsd/ files (DECISIONS, REQUIREMENTS, PROJECT, KNOWLEDGE, etc.)
  for (const f of ROOT_STATE_FILES) {
    const src = join(mainGsd, f);
    const dst = join(wtGsd, f);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        cpSync(src, dst);
        synced.push(f);
      } catch (err) {
        /* non-fatal */
        logWarning("worktree", `file copy failed (${f}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Forward-sync project preferences from project root to worktree (additive only).
  // Prefer the canonical uppercase file name, but keep the legacy lowercase
  // fallback so older repos still work on case-sensitive filesystems.
  {
    const worktreeHasPreferences = existsSync(join(wtGsd, PROJECT_PREFERENCES_FILE))
      || existsSync(join(wtGsd, LEGACY_PROJECT_PREFERENCES_FILE));
    if (!worktreeHasPreferences) {
      for (const file of [PROJECT_PREFERENCES_FILE, LEGACY_PROJECT_PREFERENCES_FILE] as const) {
        const src = join(mainGsd, file);
        const dst = join(wtGsd, file);
        if (existsSync(src)) {
          try {
            cpSync(src, dst);
            synced.push(file);
          } catch (err) {
            /* non-fatal */
            logWarning("worktree", `preferences copy failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
      }
    }
  }

  // Sync milestones: copy entire milestone directories that are missing
  const mainMilestonesDir = join(mainGsd, "milestones");
  const wtMilestonesDir = join(wtGsd, "milestones");
  if (existsSync(mainMilestonesDir)) {
    try {
      mkdirSync(wtMilestonesDir, { recursive: true });
      const mainMilestones = readdirSync(mainMilestonesDir, {
        withFileTypes: true,
      })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const mid of mainMilestones) {
        const srcDir = join(mainMilestonesDir, mid);
        const dstDir = join(wtMilestonesDir, mid);

        if (!existsSync(dstDir)) {
          // Entire milestone missing from worktree — copy it
          try {
            cpSync(srcDir, dstDir, { recursive: true });
            synced.push(`milestones/${mid}/`);
          } catch (err) {
            /* non-fatal */
            logWarning("worktree", `milestone copy failed (${mid}): ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          // Milestone directory exists but may be missing files (stale snapshot).
          // Sync individual top-level milestone files (CONTEXT, ROADMAP, RESEARCH, etc.)
          try {
            const srcFiles = readdirSync(srcDir).filter(
              (f) => f.endsWith(".md") || f.endsWith(".json"),
            );
            for (const f of srcFiles) {
              const srcFile = join(srcDir, f);
              const dstFile = join(dstDir, f);
              if (!existsSync(dstFile)) {
                try {
                  const srcStat = lstatSyncFn(srcFile);
                  if (srcStat.isFile()) {
                    cpSync(srcFile, dstFile);
                    synced.push(`milestones/${mid}/${f}`);
                  }
                } catch (err) {
                  /* non-fatal */
                  logWarning("worktree", `milestone file copy failed (${mid}/${f}): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }

            // Sync slices directory if it exists in main but not in worktree
            const srcSlicesDir = join(srcDir, "slices");
            const dstSlicesDir = join(dstDir, "slices");
            if (existsSync(srcSlicesDir) && !existsSync(dstSlicesDir)) {
              try {
                cpSync(srcSlicesDir, dstSlicesDir, { recursive: true });
                synced.push(`milestones/${mid}/slices/`);
              } catch (err) {
                /* non-fatal */
                logWarning("worktree", `slices copy failed (${mid}): ${err instanceof Error ? err.message : String(err)}`);
              }
            } else if (existsSync(srcSlicesDir) && existsSync(dstSlicesDir)) {
              // Both exist — sync missing slice directories
              const srcSlices = readdirSync(srcSlicesDir, {
                withFileTypes: true,
              })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
              for (const sid of srcSlices) {
                const srcSlice = join(srcSlicesDir, sid);
                const dstSlice = join(dstSlicesDir, sid);
                if (!existsSync(dstSlice)) {
                  try {
                    cpSync(srcSlice, dstSlice, { recursive: true });
                    synced.push(`milestones/${mid}/slices/${sid}/`);
                  } catch (err) {
                    /* non-fatal */
                    logWarning("worktree", `slice copy failed (${mid}/${sid}): ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
            }
          } catch (err) {
            /* non-fatal */
            logWarning("worktree", `milestone file sync failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      /* non-fatal */
      logWarning("worktree", `milestone directory sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { synced };
}

/**
 * Sync milestone artifacts from worktree back to the main external state directory.
 * Called before milestone merge to ensure completion artifacts (SUMMARY, VALIDATION,
 * updated ROADMAP) are visible from the project root (#1412).
 *
 * Syncs:
 *   1. Root-level .gsd/ files (REQUIREMENTS, PROJECT, DECISIONS, KNOWLEDGE,
 *      OVERRIDES) — the worktree's versions overwrite main's because the
 *      worktree is the authoritative execution context.
 *   2. ALL milestone directories found in the worktree — not just the
 *      current milestoneId. The complete-milestone unit may create artifacts
 *      for the *next* milestone (CONTEXT, ROADMAP, new requirements) which
 *      must survive worktree teardown.
 *
 * History: Originally only synced milestones/<milestoneId>/ and assumed
 * root-level files would be carried by the squash merge. In practice,
 * .gsd/ files are often untracked (gitignored or never committed), so the
 * squash merge carries nothing. This caused next-milestone artifacts and
 * updated REQUIREMENTS/PROJECT to be silently lost on teardown.
 */
export function syncWorktreeStateBack(
  mainBasePath: string,
  worktreePath: string,
  milestoneId: string,
): { synced: string[] } {
  const mainGsd = gsdRoot(mainBasePath);
  const wtGsd = gsdRoot(worktreePath);
  const synced: string[] = [];

  // If both resolve to the same directory (symlink), no sync needed
  if (isSamePath(mainGsd, wtGsd)) return { synced };

  if (!existsSync(wtGsd) || !existsSync(mainGsd)) return { synced };

  // ── 0. Pre-upgrade worktree DB reconciliation ────────────────────────
  // If the worktree has its own gsd.db (copied before the WAL transition),
  // reconcile its hierarchy data into the project root DB before syncing
  // files. This handles in-flight worktrees that were created before the
  // upgrade to shared WAL mode.
  const wtLocalDb = join(wtGsd, "gsd.db");
  const mainDb = join(mainGsd, "gsd.db");
  if (existsSync(wtLocalDb) && existsSync(mainDb)) {
    try {
      reconcileWorktreeDb(mainDb, wtLocalDb);
      synced.push("gsd.db (pre-upgrade reconcile)");
    } catch (err) {
      // Non-fatal — file sync below is the fallback
      logError("worktree", `DB reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 1. Sync root-level .gsd/ files back ──────────────────────────────
  // The worktree is authoritative — complete-milestone updates REQUIREMENTS,
  // PROJECT, etc. These must overwrite main's copies so they survive teardown.
  // Also includes QUEUE.md, completed-units.json, and metrics.json which are
  // written during milestone closeout and lost on teardown without explicit sync
  // (#1787, #2313).
  for (const f of ROOT_STATE_FILES) {
    const src = join(wtGsd, f);
    const dst = join(mainGsd, f);
    if (existsSync(src)) {
      try {
        cpSync(src, dst, { force: true });
        synced.push(f);
      } catch (err) {
        /* non-fatal */
        logWarning("worktree", `state file copy-back failed (${f}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 2. Sync ALL milestone directories ────────────────────────────────
  // The complete-milestone unit may create next-milestone artifacts (e.g.
  // M007 setup while closing M006). We must sync every milestone directory
  // in the worktree, not just the current one.
  const wtMilestonesDir = join(wtGsd, "milestones");
  if (!existsSync(wtMilestonesDir)) return { synced };

  try {
    const wtMilestones = readdirSync(wtMilestonesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const mid of wtMilestones) {
      // Skip the current milestone being merged — its files are already in the
      // milestone branch and would conflict with the squash merge (#3641).
      if (mid === milestoneId) continue;
      syncMilestoneDir(wtGsd, mainGsd, mid, synced);
    }
  } catch (err) {
    /* non-fatal */
    logWarning("worktree", `milestone sync-back failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { synced };
}

/**
 * Sync a single milestone directory from worktree to main.
 * Copies milestone-level .md files, slice-level files, and task summaries.
 */
/** Copy matching files from srcDir to dstDir (non-fatal per file). */
function syncDirFiles(
  srcDir: string,
  dstDir: string,
  filter: (name: string) => boolean,
  synced: string[],
  prefix: string,
): void {
  try {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !filter(entry.name)) continue;
      try {
        cpSync(join(srcDir, entry.name), join(dstDir, entry.name), { force: true });
        synced.push(`${prefix}${entry.name}`);
      } catch (err) {
        /* non-fatal */
        logWarning("worktree", `file copy failed (${prefix}${entry.name}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    /* non-fatal — srcDir may not be readable */
    logWarning("worktree", `directory read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function syncMilestoneDir(
  wtGsd: string,
  mainGsd: string,
  mid: string,
  synced: string[],
): void {
  const wtMilestoneDir = join(wtGsd, "milestones", mid);
  const mainMilestoneDir = join(mainGsd, "milestones", mid);

  if (!existsSync(wtMilestoneDir)) return;
  mkdirSync(mainMilestoneDir, { recursive: true });

  const isMd = (name: string): boolean => name.endsWith(".md");

  // Sync milestone-level files (SUMMARY, VALIDATION, ROADMAP, CONTEXT)
  syncDirFiles(wtMilestoneDir, mainMilestoneDir, isMd, synced, `milestones/${mid}/`);

  // Sync slice-level files (summaries, UATs) and task summaries (#1678)
  const wtSlicesDir = join(wtMilestoneDir, "slices");
  const mainSlicesDir = join(mainMilestoneDir, "slices");
  if (!existsSync(wtSlicesDir)) return;

  try {
    for (const sliceEntry of readdirSync(wtSlicesDir, { withFileTypes: true })) {
      if (!sliceEntry.isDirectory()) continue;
      const sid = sliceEntry.name;
      const wtSliceDir = join(wtSlicesDir, sid);
      const mainSliceDir = join(mainSlicesDir, sid);
      mkdirSync(mainSliceDir, { recursive: true });

      syncDirFiles(wtSliceDir, mainSliceDir, isMd, synced, `milestones/${mid}/slices/${sid}/`);

      const wtTasksDir = join(wtSliceDir, "tasks");
      const mainTasksDir = join(mainSliceDir, "tasks");
      if (existsSync(wtTasksDir)) {
        mkdirSync(mainTasksDir, { recursive: true });
        syncDirFiles(wtTasksDir, mainTasksDir, isMd, synced, `milestones/${mid}/slices/${sid}/tasks/`);
      }
    }
  } catch (err) {
    /* non-fatal */
    logWarning("worktree", `milestone slice sync failed (${mid}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
// ─── Worktree Post-Create Hook (#597) ────────────────────────────────────────

/**
 * Run the user-configured post-create hook script after worktree creation.
 * The script receives SOURCE_DIR and WORKTREE_DIR as environment variables.
 * Failure is non-fatal — returns the error message or null on success.
 *
 * Reads the hook path from git.worktree_post_create in preferences.
 * Pass hookPath directly to bypass preference loading (useful for testing).
 */
export function runWorktreePostCreateHook(
  sourceDir: string,
  worktreeDir: string,
  hookPath?: string,
): string | null {
  if (hookPath === undefined) {
    const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
    hookPath = prefs?.worktree_post_create;
  }
  if (!hookPath) return null;

  // Resolve relative paths against the source project root.
  // On Windows, convert 8.3 short paths (e.g. RUNNER~1) to long paths
  // so execFileSync can locate the file correctly.
  let resolved = isAbsolute(hookPath) ? hookPath : join(sourceDir, hookPath);
  if (!existsSync(resolved)) {
    return `Worktree post-create hook not found: ${resolved}`;
  }
  if (process.platform === "win32") {
    try { resolved = realpathSync.native(resolved); } catch (err) { /* keep original */
      logWarning("worktree", `realpath failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    // .bat/.cmd files on Windows require shell mode — execFileSync cannot
    // spawn them directly (EINVAL).
    const needsShell = process.platform === "win32" && /\.(bat|cmd)$/i.test(resolved);
    execFileSync(resolved, [], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        SOURCE_DIR: sourceDir,
        WORKTREE_DIR: worktreeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 30_000, // 30 second timeout
      shell: needsShell,
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Worktree post-create hook failed: ${msg}`;
  }
}

// ─── Auto-Worktree Branch Naming ───────────────────────────────────────────

/** Returns the git branch name for a milestone worktree (`milestone/<MID>`). */
export function autoWorktreeBranch(milestoneId: string): string {
  return `milestone/${milestoneId}`;
}

// ─── Branch-mode Entry ─────────────────────────────────────────────────────

/**
 * Enter branch isolation mode for a milestone.
 *
 * Creates `milestone/<MID>` from the integration branch (if it doesn't
 * exist yet) and checks out to it.  No worktree directory is created — the
 * project root is the working copy; only HEAD changes.
 *
 * Uses the same 3-tier integration-branch fallback as createAutoWorktree:
 *   1. META.json recorded integration branch
 *   2. git.main_branch preference
 *   3. nativeDetectMainBranch (origin/HEAD auto-detection)
 */
export function enterBranchModeForMilestone(
  basePath: string,
  milestoneId: string,
): void {
  const branch = autoWorktreeBranch(milestoneId);
  const branchExists = nativeBranchExists(basePath, branch);

  if (!branchExists) {
    // Create the milestone branch from the integration branch start-point.
    const integrationBranch =
      readIntegrationBranch(basePath, milestoneId) ?? undefined;
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    // Validate main_branch preference exists in the repo before using it —
    // a stale preference (e.g. "master" when repo uses "main") would cause
    // nativeBranchForceReset to fail with a bad start-point reference.
    const validatedPrefBranch =
      gitPrefs?.main_branch &&
      typeof gitPrefs.main_branch === "string" &&
      gitPrefs.main_branch.length > 0 &&
      nativeBranchExists(basePath, gitPrefs.main_branch)
        ? gitPrefs.main_branch
        : undefined;
    const startPoint =
      integrationBranch ??
      validatedPrefBranch ??
      nativeDetectMainBranch(basePath);

    // nativeBranchForceReset creates (or resets) branch at startPoint,
    // then checkout switches HEAD to it.
    nativeBranchForceReset(basePath, branch, startPoint);
    debugLog("auto-worktree", {
      action: "enterBranchMode",
      milestoneId,
      branch,
      startPoint,
      created: true,
    });
  } else {
    debugLog("auto-worktree", {
      action: "enterBranchMode",
      milestoneId,
      branch,
      reused: true,
    });
  }

  nativeCheckoutBranch(basePath, branch);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new auto-worktree for a milestone, chdir into it, and store
 * the original base path for later teardown.
 *
 * Atomic: chdir + originalBase update happen in the same try block
 * to prevent split-brain.
 */

/**
 * Forward-merge plan checkbox state from the project root into a freshly
 * re-attached worktree (#778).
 *
 * When auto-mode stops via crash (not graceful stop), the milestone branch
 * HEAD may be behind the filesystem state at the project root because
 * syncStateToProjectRoot() runs after every task completion but the final
 * git commit may not have happened before the crash. On restart the worktree
 * is re-attached to the branch HEAD, which has [ ] for the crashed task,
 * causing verifyExpectedArtifact() to fail and triggering an infinite
 * dispatch/skip loop.
 *
 * Fix: after re-attaching, read every *.md plan file in the milestone
 * directory at the project root and apply any [x] checkbox states that are
 * ahead of the worktree version (forward-only: never downgrade [x] → [ ]).
 *
 * This is safe because syncStateToProjectRoot() is the authoritative source
 * of post-task state at the project root — it writes the same [x] the LLM
 * produced, then the auto-commit follows. If the commit never happened, the
 * filesystem copy is still valid and correct.
 */
function reconcilePlanCheckboxes(
  projectRoot: string,
  wtPath: string,
  milestoneId: string,
): void {
  const srcMilestone = join(projectRoot, ".gsd", "milestones", milestoneId);
  const dstMilestone = join(wtPath, ".gsd", "milestones", milestoneId);
  if (!existsSync(srcMilestone) || !existsSync(dstMilestone)) return;

  // Walk all markdown files in the milestone directory (plans, summaries, etc.)
  function walkMd(dir: string): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkMd(full));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          results.push(full);
        }
      }
    } catch (err) {
      /* non-fatal */
      logWarning("worktree", `walkMd directory read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return results;
  }

  for (const srcFile of walkMd(srcMilestone)) {
    const rel = srcFile.slice(srcMilestone.length);
    const dstFile = dstMilestone + rel;
    if (!existsSync(dstFile)) continue; // only reconcile existing files

    let srcContent: string;
    let dstContent: string;
    try {
      srcContent = readFileSync(srcFile, "utf-8");
      dstContent = readFileSync(dstFile, "utf-8");
    } catch (e) {
      logWarning("worktree", `reconcilePlanCheckboxes read failed: ${(e as Error).message}`);
      continue;
    }

    if (srcContent === dstContent) continue;

    // Extract all checked task IDs from the source (project root)
    // Pattern: - [x] **T<id>: or - [x] **S<id>: (case-insensitive x)
    const checkedRe = /^- \[[xX]\] \*\*([TS]\d+):/gm;
    const srcChecked = new Set<string>();
    for (const m of srcContent.matchAll(checkedRe)) srcChecked.add(m[1]);

    if (srcChecked.size === 0) continue;

    // Forward-apply: replace [ ] → [x] for any IDs that are checked in src
    let updated = dstContent;
    let changed = false;
    for (const id of srcChecked) {
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const uncheckedRe = new RegExp(
        `^(- )\\[ \\]( \\*\\*${escapedId}:)`,
        "gm",
      );
      if (uncheckedRe.test(updated)) {
        updated = updated.replace(
          new RegExp(`^(- )\\[ \\]( \\*\\*${escapedId}:)`, "gm"),
          "$1[x]$2",
        );
        changed = true;
      }
    }

    if (changed) {
      try {
        atomicWriteSync(dstFile, updated, "utf-8");
      } catch (err) {
        /* non-fatal */
        logWarning("worktree", `plan checkbox reconcile write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function createAutoWorktree(
  basePath: string,
  milestoneId: string,
): string {
  const branch = autoWorktreeBranch(milestoneId);

  // Check if the milestone branch already exists — it survives auto-mode
  // stop/pause and contains committed work from prior sessions. If it exists,
  // re-attach the worktree to it WITHOUT resetting. Only create a fresh branch
  // from the integration branch when no prior work exists.
  const branchExists = nativeBranchExists(basePath, branch);

  let info: { name: string; path: string; branch: string; exists: boolean };
  if (branchExists) {
    // Re-attach worktree to the existing milestone branch (preserving commits)
    info = createWorktree(basePath, milestoneId, {
      branch,
      reuseExistingBranch: true,
    });
  } else {
    // Fresh start — create branch from integration branch.
    // Use the same 3-tier fallback as mergeMilestoneToMain (#3461):
    //   1. META.json integration branch (explicit per-milestone override)
    //   2. git.main_branch preference (user's configured working branch)
    //   3. nativeDetectMainBranch (origin/HEAD auto-detection)
    // Without tier 2, projects with main_branch=dev but origin/HEAD→master
    // would fork worktrees from the wrong (stale) branch.
    const integrationBranch =
      readIntegrationBranch(basePath, milestoneId) ?? undefined;
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    const startPoint = integrationBranch ?? gitPrefs?.main_branch ?? undefined;
    info = createWorktree(basePath, milestoneId, {
      branch,
      startPoint,
    });
  }

  // Copy .gsd/ planning artifacts from the source repo into the new worktree.
  // Worktrees are fresh git checkouts — untracked files don't carry over.
  // Planning artifacts may be untracked if the project's .gitignore had a
  // blanket .gsd/ rule (pre-v2.14.0). Without this copy, auto-mode loops
  // on plan-slice because the plan file doesn't exist in the worktree.
  //
  // IMPORTANT: Skip when re-attaching to an existing branch (#759).
  // The branch checkout already has committed artifacts with correct state
  // (e.g. [x] for completed slices). Copying from the project root would
  // overwrite them with stale data ([ ] checkboxes) because the root is
  // not always fully synced.
  if (!branchExists) {
    copyPlanningArtifacts(basePath, info.path);
  } else {
    // Re-attaching to an existing branch: forward-merge any plan checkpoint
    // state from the project root into the worktree (#778).
    //
    // If auto-mode stopped via crash, the milestone branch HEAD may lag behind
    // the project root filesystem because syncStateToProjectRoot() ran after
    // task completion but the auto-commit never fired. On restart the worktree
    // is re-created from the branch HEAD (which has [ ] for the crashed task),
    // causing verifyExpectedArtifact() to return false → stale-key eviction →
    // infinite dispatch/skip loop. Reconciling here ensures the worktree sees
    // the same [x] state that syncStateToProjectRoot() wrote to the root.
    reconcilePlanCheckboxes(basePath, info.path, milestoneId);
  }

  // Run user-configured post-create hook (#597) — e.g. copy .env, symlink assets
  const hookError = runWorktreePostCreateHook(basePath, info.path);
  if (hookError) {
    // Non-fatal — log but don't prevent worktree usage
    logWarning("reconcile", hookError, { worktree: info.name });
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(info.path);
    originalBase = basePath;
  } catch (err) {
    // If chdir fails, the worktree was created but we couldn't enter it.
    // Don't store originalBase -- caller can retry or clean up.
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree created at ${info.path} but chdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return info.path;
}

/**
 * Copy .gsd/ planning artifacts from source repo to a new worktree.
 * Copies milestones/, DECISIONS.md, REQUIREMENTS.md, PROJECT.md, QUEUE.md,
 * STATE.md, KNOWLEDGE.md, and OVERRIDES.md.
 * Skips runtime files (auto.lock, metrics.json, etc.) and the worktrees/ dir.
 * Best-effort — failures are non-fatal since auto-mode can recreate artifacts.
 */
function copyPlanningArtifacts(srcBase: string, wtPath: string): void {
  const srcGsd = join(srcBase, ".gsd");
  const dstGsd = join(wtPath, ".gsd");
  if (!existsSync(srcGsd)) return;
  if (isSamePath(srcGsd, dstGsd)) return;

  // Copy milestones/ directory (planning files, roadmaps, plans, research)
  safeCopyRecursive(join(srcGsd, "milestones"), join(dstGsd, "milestones"), {
    force: true,
    filter: (src) => !src.endsWith("-META.json"),
  });

  // Copy top-level planning files
  for (const file of [
    "DECISIONS.md",
    "REQUIREMENTS.md",
    "PROJECT.md",
    "QUEUE.md",
    "STATE.md",
    "KNOWLEDGE.md",
    "OVERRIDES.md",
    "mcp.json",
  ]) {
    safeCopy(join(srcGsd, file), join(dstGsd, file), { force: true });
  }

  // Seed canonical PREFERENCES.md when available; fall back to legacy lowercase.
  if (existsSync(join(srcGsd, PROJECT_PREFERENCES_FILE))) {
    safeCopy(
      join(srcGsd, PROJECT_PREFERENCES_FILE),
      join(dstGsd, PROJECT_PREFERENCES_FILE),
      { force: true },
    );
  } else if (existsSync(join(srcGsd, LEGACY_PROJECT_PREFERENCES_FILE))) {
    safeCopy(
      join(srcGsd, LEGACY_PROJECT_PREFERENCES_FILE),
      join(dstGsd, LEGACY_PROJECT_PREFERENCES_FILE),
      { force: true },
    );
  }

  // Shared WAL (R012): worktrees use the project root's DB directly.
  // No longer copy gsd.db into the worktree — the DB path resolver in
  // ensureDbOpen() detects the worktree location and opens the root DB.
  // Compat note: reconcileWorktreeDb() in mergeMilestoneToMain handles
  // worktrees that already have a local gsd.db from before this change.
}

/**
 * Teardown an auto-worktree: chdir back to original base, then remove
 * the worktree and its branch.
 */
export function teardownAutoWorktree(
  originalBasePath: string,
  milestoneId: string,
  opts: { preserveBranch?: boolean } = {},
): void {
  const branch = autoWorktreeBranch(milestoneId);
  const { preserveBranch = false } = opts;
  const previousCwd = process.cwd();

  try {
    process.chdir(originalBasePath);
    originalBase = null;
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  removeWorktree(originalBasePath, milestoneId, {
    branch,
    deleteBranch: !preserveBranch,
  });

  // Verify cleanup succeeded — warn if the worktree directory is still on disk.
  // On Windows, bash-based cleanup can silently fail when paths contain
  // backslashes (#1436), leaving ~1 GB+ orphaned directories.
  const wtDir = worktreePath(originalBasePath, milestoneId);
  if (existsSync(wtDir)) {
    logWarning(
      "reconcile",
      `Worktree directory still exists after teardown: ${wtDir}. ` +
        `This is likely an orphaned directory consuming disk space. ` +
        `Remove it manually with: rm -rf "${wtDir.replaceAll("\\", "/")}"`,
      { worktree: milestoneId },
    );
    // Attempt a direct filesystem removal as a fallback — but ONLY if the
    // path is safely inside .gsd/worktrees/ to prevent #2365 data loss.
    if (isInsideWorktreesDir(originalBasePath, wtDir)) {
      try {
        rmSync(wtDir, { recursive: true, force: true });
      } catch (err) {
        // Non-fatal — the warning above tells the user how to clean up
        logWarning("worktree", `worktree directory removal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.error(
        `[GSD] REFUSING fallback rmSync — path is outside .gsd/worktrees/: ${wtDir}`,
      );
    }
  }
}

/**
 * Detect if the process is currently inside an auto-worktree.
 * Checks both module state and git branch prefix.
 */
export function isInAutoWorktree(basePath: string): boolean {
  if (!originalBase) return false;
  const cwd = process.cwd();
  const resolvedBase = existsSync(basePath) ? realpathSync(basePath) : basePath;
  const wtDir = join(resolvedBase, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return false;
  const branch = nativeGetCurrentBranch(cwd);
  return branch.startsWith("milestone/");
}

/**
 * Get the filesystem path for an auto-worktree, or null if it doesn't exist
 * or is not a valid git worktree.
 *
 * Validates that the path is a real git worktree (has a .git file with a
 * gitdir: pointer) rather than just a stray directory. This prevents
 * mis-detection of leftover directories as active worktrees (#695).
 */
export function getAutoWorktreePath(
  basePath: string,
  milestoneId: string,
): string | null {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) return null;

  // Validate this is a real git worktree, not a stray directory.
  // A git worktree has a .git *file* (not directory) containing "gitdir: <path>".
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) return null;
  } catch (e) {
    logWarning("worktree", `getAutoWorktreePath .git read failed: ${(e as Error).message}`);
    return null;
  }

  return p;
}

/**
 * Enter an existing auto-worktree (chdir into it, store originalBase).
 * Use for resume -- the worktree already exists from a prior create.
 *
 * Atomic: chdir + originalBase update in same try block.
 */
export function enterAutoWorktree(
  basePath: string,
  milestoneId: string,
): string {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree for ${milestoneId} does not exist at ${p}`,
    );
  }

  // Validate this is a real git worktree, not a stray directory (#695)
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Auto-worktree path ${p} exists but is not a git worktree (no .git)`,
    );
  }
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `Auto-worktree path ${p} has a .git but it is not a worktree gitdir pointer`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("worktree")) throw err;
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree path ${p} exists but .git is unreadable`,
    );
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(p);
    originalBase = basePath;
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to enter auto-worktree at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return p;
}

/**
 * Get the original project root stored when entering an auto-worktree.
 * Returns null if not currently in an auto-worktree.
 */
export function getAutoWorktreeOriginalBase(): string | null {
  return originalBase;
}

export function getActiveAutoWorktreeContext(): {
  originalBase: string;
  worktreeName: string;
  branch: string;
} | null {
  if (!originalBase) return null;
  const cwd = process.cwd();
  const resolvedBase = existsSync(originalBase)
    ? realpathSync(originalBase)
    : originalBase;
  const wtDir = join(resolvedBase, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return null;
  const worktreeName = detectWorktreeName(cwd);
  if (!worktreeName) return null;
  const branch = nativeGetCurrentBranch(cwd);
  if (!branch.startsWith("milestone/")) return null;
  return {
    originalBase,
    worktreeName,
    branch,
  };
}

// ─── Merge Milestone -> Main ───────────────────────────────────────────────

/**
 * Auto-commit any dirty (uncommitted) state in the given directory.
 * Returns true if a commit was made, false if working tree was clean.
 */
function autoCommitDirtyState(cwd: string): boolean {
  try {
    const status = nativeWorkingTreeStatus(cwd);
    if (!status) return false;
    nativeAddAllWithExclusions(cwd, RUNTIME_EXCLUSION_PATHS);
    const result = nativeCommit(
      cwd,
      "chore: auto-commit before milestone merge",
    );
    return result !== null;
  } catch (e) {
    debugLog("autoCommitDirtyState", { error: String(e) });
    return false;
  }
}

/**
 * Squash-merge the milestone branch into main with a rich commit message
 * listing all completed slices, then tear down the worktree.
 *
 * Sequence:
 *  1. Auto-commit dirty worktree state
 *  2. chdir to originalBasePath
 *  3. git checkout main
 *  4. git merge --squash milestone/<MID>
 *  5. git commit with rich message
 *  6. Auto-push if enabled
 *  7. Delete milestone branch
 *  8. Remove worktree directory
 *  9. Clear originalBase
 *
 * On merge conflict: throws MergeConflictError.
 * On "nothing to commit" after squash: safe only if milestone work is already
 * on the integration branch.  Throws if unanchored code changes would be lost.
 */
export function mergeMilestoneToMain(
  originalBasePath_: string,
  milestoneId: string,
  roadmapContent: string,
): { commitMessage: string; pushed: boolean; prCreated: boolean; codeFilesChanged: boolean } {
  const worktreeCwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);

  // 1. Auto-commit dirty state before leaving.
  //    Guard: when we entered through an auto-worktree (originalBase is set),
  //    only auto-commit when cwd is on the milestone branch. In parallel mode,
  //    cwd may be on the integration branch after a prior merge's
  //    MergeConflictError left cwd unrestored. Auto-committing on the
  //    integration branch captures dirty files from OTHER milestones under a
  //    misleading commit message, contaminating the main branch (#2929).
  //
  //    When originalBase is null (branch mode, no worktree), autoCommitDirtyState
  //    runs unconditionally — the caller is responsible for cwd placement.
  {
    let shouldAutoCommit = true;
    if (originalBase !== null) {
      try {
        const currentBranch = nativeGetCurrentBranch(worktreeCwd);
        shouldAutoCommit = currentBranch === milestoneBranch;
      } catch {
        // If we can't determine the branch, skip the auto-commit to be safe
        shouldAutoCommit = false;
      }
    }
    if (shouldAutoCommit) {
      autoCommitDirtyState(worktreeCwd);
    }
  }

  // Reconcile worktree DB into main DB before leaving worktree context.
  // Skip when both paths resolve to the same physical file (shared WAL /
  // symlink layout) — ATTACHing a WAL-mode file to itself corrupts the
  // database (#2823).
  if (isDbAvailable()) {
    try {
      const worktreeDbPath = join(worktreeCwd, ".gsd", "gsd.db");
      const mainDbPath = join(originalBasePath_, ".gsd", "gsd.db");
      if (!isSamePath(worktreeDbPath, mainDbPath)) {
        reconcileWorktreeDb(mainDbPath, worktreeDbPath);
      }
    } catch (err) {
      /* non-fatal */
      logError("worktree", `DB reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Get completed slices for commit message
  let completedSlices: { id: string; title: string }[] = [];
  if (isDbAvailable()) {
    completedSlices = getMilestoneSlices(milestoneId)
      .filter(s => s.status === "complete")
      .map(s => ({ id: s.id, title: s.title }));
  }
  // Fallback: parse roadmap content when DB is unavailable
  if (completedSlices.length === 0 && roadmapContent) {
    const sliceRe = /- \[x\] \*\*(\w+):\s*(.+?)\*\*/gi;
    let m: RegExpExecArray | null;
    while ((m = sliceRe.exec(roadmapContent)) !== null) {
      completedSlices.push({ id: m[1], title: m[2] });
    }
  }

  // 3. chdir to original base
  const previousCwd = process.cwd();
  process.chdir(originalBasePath_);

  // 4. Resolve integration branch — prefer milestone metadata, then preferences,
  //    then auto-detect (origin/HEAD → main → master → current). Never hardcode
  //    "main": repos using "master" or a custom default branch would fail at
  //    checkout and leave the user with a broken merge state (#1668).
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const integrationBranch = readIntegrationBranch(
    originalBasePath_,
    milestoneId,
  );
  // Validate prefs.main_branch exists before using it — a stale preference
  // (e.g. "master" when repo uses "main") causes merge failure (#3589).
  const validatedPrefBranch = prefs.main_branch && nativeBranchExists(originalBasePath_, prefs.main_branch)
    ? prefs.main_branch
    : undefined;
  const mainBranch =
    integrationBranch ?? validatedPrefBranch ?? nativeDetectMainBranch(originalBasePath_);

  // Remove transient project-root state files before any branch or merge
  // operation. Untracked milestone metadata can otherwise block squash merges.
  clearProjectRootStateFiles(originalBasePath_, milestoneId);

  // 5. Checkout integration branch (skip if already current — avoids git error
  //    when main is already checked out in the project-root worktree, #757)
  const currentBranchAtBase = nativeGetCurrentBranch(originalBasePath_);
  if (currentBranchAtBase !== mainBranch) {
    nativeCheckoutBranch(originalBasePath_, mainBranch);
  }

  // 6. Build rich commit message
  const dbMilestone = getMilestone(milestoneId);
  let milestoneTitle =
    (dbMilestone?.title ?? "").replace(/^M\d+:\s*/, "").trim();
  // Fallback: parse title from roadmap content header (e.g. "# M020: Backend foundation")
  if (!milestoneTitle && roadmapContent) {
    const titleMatch = roadmapContent.match(new RegExp(`^#\\s+${milestoneId}:\\s*(.+)`, "m"));
    if (titleMatch) milestoneTitle = titleMatch[1].trim();
  }
  milestoneTitle = milestoneTitle || milestoneId;
  const subject = `feat: ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices
      .map((s) => `- ${s.id}: ${s.title}`)
      .join("\n");
    body = `\n\nCompleted slices:\n${sliceLines}\n\nGSD-Milestone: ${milestoneId}\nBranch: ${milestoneBranch}`;
  } else {
    body = `\n\nGSD-Milestone: ${milestoneId}\nBranch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;

  // 6b. Reconcile worktree HEAD with milestone branch ref (#1846).
  //     When the worktree HEAD detaches and advances past the named branch,
  //     the branch ref becomes stale. Squash-merging the stale ref silently
  //     orphans all commits between the branch ref and the actual worktree HEAD.
  //     Fix: fast-forward the branch ref to the worktree HEAD before merging.
  //     Only applies when merging from an actual worktree (worktreeCwd differs
  //     from originalBasePath_).
  if (worktreeCwd !== originalBasePath_) {
    try {
      const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreeCwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();
      const branchHead = execFileSync("git", ["rev-parse", milestoneBranch], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();

      if (worktreeHead && branchHead && worktreeHead !== branchHead) {
        if (nativeIsAncestor(originalBasePath_, branchHead, worktreeHead)) {
          // Worktree HEAD is strictly ahead — fast-forward the branch ref
          nativeUpdateRef(
            originalBasePath_,
            `refs/heads/${milestoneBranch}`,
            worktreeHead,
          );
          debugLog("mergeMilestoneToMain", {
            action: "fast-forward-branch-ref",
            milestoneBranch,
            oldRef: branchHead.slice(0, 8),
            newRef: worktreeHead.slice(0, 8),
          });
        } else {
          // Diverged — fail loudly rather than silently losing commits
          process.chdir(previousCwd);
          throw new GSDError(
            GSD_GIT_ERROR,
            `Worktree HEAD (${worktreeHead.slice(0, 8)}) diverged from ` +
              `${milestoneBranch} (${branchHead.slice(0, 8)}). ` +
              `Manual reconciliation required before merge.`,
          );
        }
      }
    } catch (err) {
      // Re-throw GSDError (divergence); swallow rev-parse failures
      // (e.g. worktree dir already removed by external cleanup)
      if (err instanceof GSDError) throw err;
      debugLog("mergeMilestoneToMain", {
        action: "reconcile-skipped",
        reason: String(err),
      });
    }
  }

  // 7. Shelter queued milestone directories before the squash merge (#2505).
  // The milestone branch may contain copies of queued milestone dirs (via
  // copyPlanningArtifacts), so `git merge --squash` rejects when those same
  // files exist as untracked in the working tree. Temporarily move them to
  // a backup location, then restore after the merge+commit.
  //
  // MUST run BEFORE the pre-merge stash (step 7a) so `--include-untracked`
  // does not sweep queued CONTEXT files into the stash. If stash pop later
  // fails, files trapped inside the stash are permanently lost (#2505).
  const milestonesDir = join(gsdRoot(originalBasePath_), "milestones");
  const shelterDir = join(gsdRoot(originalBasePath_), ".milestone-shelter");
  const shelteredDirs: string[] = [];
  let shelterRestored = false;

  // Helper: restore sheltered milestone directories (#2505).
  // Called on both success and error paths to ensure queued CONTEXT files
  // are never permanently lost. Idempotent — the error path may fire after
  // the success path has already restored and removed the shelter dir; a
  // second call is a no-op instead of logging a misleading "shelter restore
  // failed: ENOENT" error for shelter sources that were cleaned up legitimately.
  const restoreShelter = (): void => {
    if (shelterRestored) return;
    shelterRestored = true;
    if (shelteredDirs.length === 0) return;
    let restoreFailed = false;
    for (const dirName of shelteredDirs) {
      const src = join(shelterDir, dirName);
      // If the shelter source is missing the restore cannot proceed for this
      // entry. Distinguish "legitimately missing" (shelter dir removed by a
      // prior successful restore or never copied) from a surprising ENOENT
      // inside an otherwise-populated shelter.
      if (!existsSync(src)) {
        logWarning(
          "worktree",
          `shelter source missing for ${dirName}; skipping restore (shelter already cleaned or entry never staged)`,
        );
        continue;
      }
      try {
        mkdirSync(milestonesDir, { recursive: true });
        cpSync(src, join(milestonesDir, dirName), { recursive: true, force: true });
      } catch (err) { /* best-effort */
        restoreFailed = true;
        logError("worktree", `shelter restore failed (${dirName}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Preserve the shelter if any per-entry restore failed — it is the only
    // surviving copy of the queued milestone dirs (sources were deleted during
    // shelter). Deleting it here would permanently lose those files (#2505).
    if (restoreFailed) {
      logWarning("worktree", `shelter retained at ${shelterDir} — manual recovery required for unrestored entries`);
      return;
    }
    if (existsSync(shelterDir)) {
      try { rmSync(shelterDir, { recursive: true, force: true }); } catch (err) { /* best-effort */
        logWarning("worktree", `shelter cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  try {
    if (existsSync(milestonesDir)) {
      const entries = readdirSync(milestonesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Only shelter directories that do NOT belong to the milestone being merged
        if (entry.name === milestoneId) continue;
        const srcDir = join(milestonesDir, entry.name);
        const dstDir = join(shelterDir, entry.name);
        try {
          mkdirSync(shelterDir, { recursive: true });
          cpSync(srcDir, dstDir, { recursive: true, force: true });
          rmSync(srcDir, { recursive: true, force: true });
          shelteredDirs.push(entry.name);
        } catch (err) {
          // Non-fatal — if shelter fails, the merge may still succeed
          logWarning("worktree", `milestone shelter failed (${entry.name}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    // Non-fatal — proceed with merge; untracked files may block it
    logWarning("worktree", `milestone shelter operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7a. Stash pre-existing dirty files so the squash merge is not blocked by
  //     unrelated local changes (#2151). Includes untracked files to handle
  //     locally-added files that conflict with tracked files on the milestone
  //     branch. Passing NO pathspec lets git skip gitignored paths silently;
  //     adding an explicit pathspec trips a `git add`-style fatal on ignored
  //     entries (e.g. a gitignored `.gsd` symlink under ADR-002) (#4573).
  //     Queued CONTEXT files under `.gsd/milestones/*` are already sheltered
  //     in step 7 above, so they won't be swept into the stash.
  // On Windows, SQLite holds mandatory file locks on the gsd.db WAL/SHM
  // sidecars while the connection is open. `git stash --include-untracked`
  // walks those files and fails with EBUSY (#4704). Close the DB before
  // stashing so Windows releases the handles; reopen after. No-op on
  // POSIX, where advisory locks don't block git.
  const needsDbCycle = process.platform === "win32" && isDbAvailable();
  const dbPathToReopen = needsDbCycle ? getDbPath() : null;
  if (needsDbCycle) {
    try {
      closeDatabase();
    } catch (err) {
      logWarning("worktree", `pre-stash db close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let stashed = false;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: originalBasePath_,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (status) {
      execFileSync(
        "git",
        ["stash", "push", "--include-untracked", "-m", `gsd: pre-merge stash for ${milestoneId}`],
        { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      );
      stashed = true;
    }
  } catch (err) {
    // Stash failure is non-fatal — proceed without stash and let the merge
    // report the dirty tree if it fails.
    logWarning("worktree", `git stash failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (needsDbCycle && dbPathToReopen) {
    try {
      openDatabase(dbPathToReopen);
    } catch (err) {
      logWarning("worktree", `post-stash db reopen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 7b. Clean up stale merge state before attempting squash merge (#2912).
  // A leftover MERGE_HEAD (from a previous failed merge, libgit2 native path,
  // or interrupted operation) causes `git merge --squash` to refuse with
  // "fatal: You have not concluded your merge (MERGE_HEAD exists)".
  // Defensively remove merge artifacts before starting.
  try {
    const gitDir_ = resolveGitDir(originalBasePath_);
    for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
      const p = join(gitDir_, f);
      if (existsSync(p)) unlinkSync(p);
    }
  } catch (err) { /* best-effort */
    logError("worktree", `merge state cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 8. Squash merge — auto-resolve .gsd/ state file conflicts (#530)
  const mergeResult = nativeMergeSquash(originalBasePath_, milestoneBranch);

  if (!mergeResult.success) {
    // Dirty working tree — the merge was rejected before it started (e.g.
    // untracked .gsd/ files left by syncStateToProjectRoot).  Preserve the
    // milestone branch so commits are not lost.
    if (mergeResult.conflicts.includes("__dirty_working_tree__")) {
      // Defensively clean merge state — the native path may leave MERGE_HEAD
      // even when the merge is rejected (#2912).
      try {
        const gitDir_ = resolveGitDir(originalBasePath_);
        for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
          const p = join(gitDir_, f);
          if (existsSync(p)) unlinkSync(p);
        }
      } catch (err) { /* best-effort */
        logError("worktree", `merge state cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Pop stash before throwing so local work is not lost.
      if (stashed) {
        try {
          execFileSync("git", ["stash", "pop"], {
            cwd: originalBasePath_,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8",
          });
        } catch (err) { /* stash pop conflict is non-fatal */
          logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      restoreShelter();
      // Restore cwd so the caller is not stranded on the integration branch
      process.chdir(previousCwd);
      // Surface the actual dirty filenames from git stderr instead of
      // generically blaming .gsd/ (#2151).
      const fileList = mergeResult.dirtyFiles?.length
        ? `Dirty files:\n${mergeResult.dirtyFiles.map((f) => `  ${f}`).join("\n")}`
        : `Check \`git status\` in the project root for details.`;
      throw new GSDError(
        GSD_GIT_ERROR,
        `Squash merge of ${milestoneBranch} rejected: working tree has dirty or untracked files ` +
          `that conflict with the merge. ${fileList}`,
      );
    }

    // Check for conflicts — use merge result first, fall back to nativeConflictFiles
    const conflictedFiles =
      mergeResult.conflicts.length > 0
        ? mergeResult.conflicts
        : nativeConflictFiles(originalBasePath_);

    if (conflictedFiles.length > 0) {
      // Separate auto-resolvable conflicts (GSD state files + build artifacts)
      // from real code conflicts. GSD state files diverge between branches
      // during normal operation. Build artifacts are machine-generated and
      // regenerable. Both are safe to accept from the milestone branch.
      const autoResolvable = conflictedFiles.filter(isSafeToAutoResolve);
      const codeConflicts = conflictedFiles.filter(
        (f) => !isSafeToAutoResolve(f),
      );

      // Auto-resolve safe conflicts by accepting the milestone branch version
      if (autoResolvable.length > 0) {
        for (const safeFile of autoResolvable) {
          try {
            nativeCheckoutTheirs(originalBasePath_, [safeFile]);
            nativeAddPaths(originalBasePath_, [safeFile]);
          } catch (e) {
            // If checkout --theirs fails, try removing the file from the merge
            // (it's a runtime file that shouldn't be committed anyway)
            logWarning("worktree", `checkout --theirs failed for ${safeFile}, removing: ${(e as Error).message}`);
            nativeRmForce(originalBasePath_, [safeFile]);
          }
        }
      }

      // If there are still real code conflicts, escalate
      if (codeConflicts.length > 0) {
        // Abort merge state so MERGE_HEAD is not left on disk (#2912).
        // libgit2's merge creates MERGE_HEAD even for squash merges; if left
        // dangling, subsequent merges fail and doctor reports corrupt state.
        try { nativeMergeAbort(originalBasePath_); } catch (err) { /* best-effort */
          logError("worktree", `git merge-abort failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          const gitDir_ = resolveGitDir(originalBasePath_);
          for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
            const p = join(gitDir_, f);
            if (existsSync(p)) unlinkSync(p);
          }
        } catch (err) { /* best-effort */
          logError("worktree", `merge state file cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Pop stash before throwing so local work is not lost (#2151).
        if (stashed) {
          try {
            execFileSync("git", ["stash", "pop"], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
            });
          } catch (err) { /* stash pop conflict is non-fatal */
            logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        restoreShelter();
        // Restore cwd so the caller is not stranded on the integration branch.
        // Without this, the next mergeMilestoneToMain call in a parallel merge
        // sequence uses process.cwd() (now the project root) as worktreeCwd,
        // causing autoCommitDirtyState to commit unrelated milestone files to
        // the integration branch (#2929).
        process.chdir(previousCwd);
        throw new MergeConflictError(
          codeConflicts,
          "squash",
          milestoneBranch,
          mainBranch,
        );
      }
    }
    // No conflicts detected — possibly "already up to date", fall through to commit
  }

  // 9. Commit (handle nothing-to-commit gracefully)
  const commitResult = nativeCommit(originalBasePath_, commitMessage);
  const nothingToCommit = commitResult === null;

  // 9a. Clean up merge state files left by git merge --squash (#1853, #2912).
  // git only removes SQUASH_MSG when the commit reads it directly (plain
  // `git commit`).  nativeCommit uses `-F -` (stdin) or libgit2, neither
  // of which trigger git's SQUASH_MSG cleanup.  MERGE_HEAD is created by
  // libgit2's merge even in squash mode and is not removed by nativeCommit.
  // If left on disk, doctor reports `corrupt_merge_state` on every subsequent run.
  try {
    const gitDir_ = resolveGitDir(originalBasePath_);
    for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
      const p = join(gitDir_, f);
      if (existsSync(p)) unlinkSync(p);
    }
  } catch (err) { /* best-effort */
    logError("worktree", `post-commit merge state cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 9a-ii. Restore stashed files now that the merge+commit is complete (#2151).
  // Pop after commit so stashed changes do not interfere with the squash merge
  // or the commit content.  Conflict on pop is non-fatal — the stash entry is
  // preserved and the user can resolve manually with `git stash pop`.
  if (stashed) {
    try {
      execFileSync("git", ["stash", "pop"], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch (e) {
      logWarning("worktree", `git stash pop failed, attempting conflict resolution: ${(e as Error).message}`);
      // Stash pop after squash merge can conflict on .gsd/ state files that
      // diverged between branches.  Left unresolved, these UU entries block
      // every subsequent merge.  Auto-resolve them the same way we handle
      // .gsd/ conflicts during the merge itself: accept HEAD (the just-committed
      // version) and drop the now-applied stash.
      const uu = nativeConflictFiles(originalBasePath_);
      const gsdUU = uu.filter((f) => f.startsWith(".gsd/"));
      const nonGsdUU = uu.filter((f) => !f.startsWith(".gsd/"));

      if (gsdUU.length > 0) {
        for (const f of gsdUU) {
          try {
            // Accept the committed (HEAD) version of the state file
            execFileSync("git", ["checkout", "HEAD", "--", f], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
            });
            nativeAddPaths(originalBasePath_, [f]);
          } catch (e) {
            // Last resort: remove the conflicted state file
            logWarning("worktree", `checkout HEAD failed for ${f}, removing: ${(e as Error).message}`);
            nativeRmForce(originalBasePath_, [f]);
          }
        }
      }

      if (nonGsdUU.length === 0) {
        // All conflicts were .gsd/ files — safe to drop the stash
        try {
          execFileSync("git", ["stash", "drop"], {
            cwd: originalBasePath_,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8",
          });
        } catch (err) { /* stash may already be consumed */
          logWarning("worktree", `git stash drop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // Non-.gsd conflicts remain — leave stash for manual resolution
        logWarning("reconcile", "Stash pop conflict on non-.gsd files after merge", {
          files: nonGsdUU.join(", "),
        });
      }
    }
  }

  // 9a-iii. Restore sheltered queued milestone directories (#2505).
  restoreShelter();

  // 9b. Safety check (#1792): if nothing was committed, verify the milestone
  // work is already on the integration branch before allowing teardown.
  // Compare only non-.gsd/ paths — .gsd/ state files diverge normally and
  // are auto-resolved during the squash merge.
  if (nothingToCommit) {
    const numstat = nativeDiffNumstat(
      originalBasePath_,
      mainBranch,
      milestoneBranch,
    );
    const codeChanges = numstat.filter(
      (entry) => !entry.path.startsWith(".gsd/"),
    );
    if (codeChanges.length > 0) {
      // Milestone has unanchored code changes — abort teardown.
      process.chdir(previousCwd);
      throw new GSDError(
        GSD_GIT_ERROR,
        `Squash merge produced nothing to commit but milestone branch "${milestoneBranch}" ` +
          `has ${codeChanges.length} code file(s) not on "${mainBranch}". ` +
          `Aborting worktree teardown to prevent data loss.`,
      );
    }
  }

  // 9c. Detect whether any non-.gsd/ code files were actually merged (#1906).
  // When a milestone only produced .gsd/ metadata (summaries, roadmaps) but no
  // real code, the user sees "milestone complete" but nothing changed in their
  // codebase. Surface this so the caller can warn the user.
  //
  // Bug #4385 fix: use `git diff-tree --root` instead of `git diff HEAD~1 HEAD`.
  // `HEAD~1` does not exist on initial commits and is unreliable on shallow clones
  // and merge commits. `diff-tree --root` handles all three cases correctly.
  // The empty-tree hash (4b825dc…) is the universal fallback for refs that don't exist.
  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let codeFilesChanged = false;
  if (!nothingToCommit) {
    try {
      const diffTreeOutput = execFileSync(
        "git",
        ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"],
        { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      ).trim();
      const mergedFiles = diffTreeOutput ? diffTreeOutput.split("\n").filter(Boolean) : [];
      codeFilesChanged = mergedFiles.some((f) => !f.startsWith(".gsd/"));
    } catch (e) {
      // diff-tree failed (e.g. unborn HEAD in a brand-new repo) — fall back to
      // comparing against the empty tree so initial-commit repos still report changes.
      try {
        const fallbackOutput = execFileSync(
          "git",
          ["diff", "--name-only", GIT_EMPTY_TREE, "HEAD"],
          { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
        ).trim();
        const fallbackFiles = fallbackOutput ? fallbackOutput.split("\n").filter(Boolean) : [];
        codeFilesChanged = fallbackFiles.some((f) => !f.startsWith(".gsd/"));
      } catch {
        // Truly unable to determine — assume code was changed to avoid silent data loss
        logWarning("worktree", `diff-tree and empty-tree fallback both failed (assuming code changed): ${(e as Error).message}`);
        codeFilesChanged = true;
      }
    }
  }

  // 10. Auto-push if enabled
  let pushed = false;
  if (prefs.auto_push === true && !nothingToCommit) {
    const remote = prefs.remote ?? "origin";
    try {
      execFileSync("git", ["push", remote, mainBranch], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      pushed = true;
    } catch (err) {
      // Push failure is non-fatal
      logWarning("worktree", `git push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 9b. Auto-create PR if enabled (#2302: no longer gated on pushed/auto_push)
  let prCreated = false;
  if (prefs.auto_pr === true && !nothingToCommit) {
    const remote = prefs.remote ?? "origin";
    const prTarget = prefs.pr_target_branch ?? mainBranch;
    try {
      // Push the milestone branch to remote first
      execFileSync("git", ["push", remote, milestoneBranch], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      // Create PR via gh CLI with explicit --head and --base (#2302)
      execFileSync("gh", [
        "pr", "create", "--draft",
        "--base", prTarget,
        "--head", milestoneBranch,
        "--title", `Milestone ${milestoneId} complete`,
        "--body", "Auto-created by GSD on milestone completion.",
      ], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      prCreated = true;
    } catch (err) {
      // PR creation failure is non-fatal — gh may not be installed or authenticated
      logWarning("worktree", `PR creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 11. Guard removed — step 9b (#1792) now handles this with a smarter check:
  //     throws only when the milestone has unanchored code changes, passes
  //     through when the code is genuinely already on the integration branch.

  // 11a. Pre-teardown safety net (#1853): if the worktree still has uncommitted
  // changes (e.g. nativeHasChanges cache returned stale false, or auto-commit
  // silently failed), force one final commit so code is not destroyed by
  // `git worktree remove --force`.
  //
  // Guard: only run when worktreeCwd is on the milestone branch (#2929).
  // In parallel mode or branch-mode merges, worktreeCwd may be the project
  // root on the integration branch. Committing dirty state there would
  // capture unrelated files from other milestones.
  if (existsSync(worktreeCwd)) {
    let preTeardownBranch: string | null = null;
    try {
      preTeardownBranch = nativeGetCurrentBranch(worktreeCwd);
    } catch (err) {
      debugLog("mergeMilestoneToMain", { phase: "pre-teardown-branch-detect-failed", error: String(err) });
    }
    const isOnMilestoneBranch = preTeardownBranch === milestoneBranch;

    if (isOnMilestoneBranch) {
      try {
        const dirtyCheck = nativeWorkingTreeStatus(worktreeCwd);
        if (dirtyCheck) {
          debugLog("mergeMilestoneToMain", {
            phase: "pre-teardown-dirty",
            worktreeCwd,
            status: dirtyCheck.slice(0, 200),
          });
          nativeAddAllWithExclusions(worktreeCwd, RUNTIME_EXCLUSION_PATHS);
          nativeCommit(worktreeCwd, "chore: pre-teardown auto-commit of uncommitted worktree changes");
        }
      } catch (e) {
        debugLog("mergeMilestoneToMain", {
          phase: "pre-teardown-commit-error",
          error: String(e),
        });
      }
    }
  }

  // 12. Remove worktree directory first (must happen before branch deletion)
  try {
    removeWorktree(originalBasePath_, milestoneId, {
      branch: milestoneBranch,
      deleteBranch: false,
    });
  } catch (err) {
    // Best-effort -- worktree dir may already be gone
    logWarning("worktree", `worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 13. Delete milestone branch (after worktree removal so ref is unlocked)
  try {
    nativeBranchDelete(originalBasePath_, milestoneBranch);
  } catch (err) {
    // Best-effort
    logWarning("worktree", `git branch-delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 14. Clear module state
  originalBase = null;
  nudgeGitBranchCache(previousCwd);

  return { commitMessage, pushed, prCreated, codeFilesChanged };
}
