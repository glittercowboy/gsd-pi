/**
 * Auto-mode Recovery — artifact resolution, verification, blocker placeholders,
 * skip artifacts, merge state reconciliation,
 * self-heal runtime records, and loop remediation steps.
 *
 * Pure functions that receive all needed state as parameters — no module-level
 * globals or AutoContext dependency.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { parseUnitId } from "./unit-id.js";
import { appendEvent } from "./workflow-events.js";
import { atomicWriteSync } from "./atomic-write.js";
import { clearParseCache } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap, parsePlan as parseLegacyPlan } from "./parsers-legacy.js";
import { isDbAvailable, getTask, getSlice, getSliceTasks, getPendingGates, updateTaskStatus, updateSliceStatus } from "./gsd-db.js";
import { isValidationTerminal } from "./state.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning, logError } from "./workflow-logger.js";
import {
  nativeConflictFiles,
  nativeCommit,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeMergeAbort,
  nativeResetHard,
} from "./native-git-bridge.js";
import {
  resolveSlicePath,
  resolveSliceFile,
  resolveTasksDir,
  resolveTaskFiles,
  relMilestoneFile,
  relSliceFile,
  buildSliceFileName,
  resolveMilestoneFile,
  clearPathCache,
  resolveGsdRootFile,
} from "./paths.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact,
} from "./auto-artifact-paths.js";

// Re-export so existing consumers of auto-recovery.ts keep working.
export { resolveExpectedArtifactPath, diagnoseExpectedArtifact };

// ─── Artifact Resolution & Verification ───────────────────────────────────────

/**
 * Check whether a milestone produced implementation artifacts (non-`.gsd/` files)
 * in the git history. Uses `git log --name-only` to inspect all commits on the
 * current branch that touch files outside `.gsd/`.
 *
 * Returns "present" if implementation files found, "absent" if only .gsd/ files,
 * "unknown" if git is unavailable or check failed (callers decide how to handle).
 */
export function hasImplementationArtifacts(basePath: string): "present" | "absent" | "unknown" {
  try {
    // Verify we're in a git repo
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch (e) {
      logWarning("recovery", `git rev-parse check failed: ${(e as Error).message}`);
      return "unknown";
    }

    // Strategy: check `git diff --name-only` against the merge-base with the
    // main branch. This captures ALL files changed during the milestone's
    // lifetime. If no merge-base exists (e.g., single-branch workflow), fall
    // back to checking the last N commits.
    const mainBranch = detectMainBranch(basePath);
    const changedFiles = getChangedFilesSinceBranch(basePath, mainBranch);

    // No files changed at all — unknown (could be detached HEAD, single-
    // commit repo, or other edge case where git diff returns nothing).
    if (changedFiles.length === 0) return "unknown";

    // Filter out .gsd/ files — only implementation files count.
    // If every changed file is under .gsd/, the milestone produced no
    // implementation code (#1703).
    const implFiles = changedFiles.filter(f => !f.startsWith(".gsd/") && !f.startsWith(".gsd\\"));
    return implFiles.length > 0 ? "present" : "absent";
  } catch (e) {
    // Non-fatal — if git operations fail, return unknown so callers can decide
    logWarning("recovery", `implementation artifact check failed: ${(e as Error).message}`);
    return "unknown";
  }
}

/**
 * Detect the main/master branch name.
 */
function detectMainBranch(basePath: string): string {
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "main"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.trim()) return "main";
  } catch (_) {
    // Expected — main doesn't exist, try master next
    void _;
  }
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "master"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.trim()) return "master";
  } catch (_) {
    // Expected — master doesn't exist either
    void _;
  }
  // Neither main nor master found — warn and fall back
  logWarning("recovery", "neither main nor master branch found, defaulting to main");
  return "main";
}

/**
 * Get files changed since the branch diverged from the target branch.
 * Falls back to checking HEAD~20 if merge-base detection fails.
 */
function getChangedFilesSinceBranch(basePath: string, targetBranch: string): string[] {
  try {
    // Try merge-base approach first
    const mergeBase = execFileSync(
      "git", ["merge-base", targetBranch, "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();

    if (mergeBase) {
      const result = execFileSync(
        "git", ["diff", "--name-only", mergeBase, "HEAD"],
        { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      ).trim();
      return result ? result.split("\n").filter(Boolean) : [];
    }
  } catch (err) {
    // merge-base failed — fall back
    logWarning("recovery", `merge-base detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: check last 20 commits
  try {
    const result = execFileSync(
      "git", ["log", "--name-only", "--pretty=format:", "-20", "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    return result ? [...new Set(result.split("\n").filter(Boolean))] : [];
  } catch (e) {
    logWarning("recovery", `git log fallback failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Check whether the expected artifact(s) for a unit exist on disk.
 * Returns true if all required artifacts exist, or if the unit type has no
 * single verifiable artifact (e.g., replan-slice).
 *
 * complete-slice requires both SUMMARY and UAT files — verifying only
 * the summary allowed the unit to be marked complete when the LLM
 * skipped writing the UAT file (see #176).
 */
export function verifyExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): boolean {
  // Hook units have no standard artifact — always pass. Their lifecycle
  // is managed by the hook engine, not the artifact verification system.
  if (unitType.startsWith("hook/")) return true;

  // Clear stale directory listing cache AND parse cache so artifact checks see
  // fresh disk state (#431). The parse cache must also be cleared because
  // cacheKey() uses length + first/last 100 chars — when a checkbox changes
  // from [ ] to [x], the key collides with the pre-edit version, returning
  // stale parsed results (e.g., slice.done = false when it's actually true).
  clearPathCache();
  clearParseCache();

  if (unitType === "rewrite-docs") {
    const overridesPath = resolveGsdRootFile(base, "OVERRIDES");
    if (!existsSync(overridesPath)) return true;
    const content = readFileSync(overridesPath, "utf-8");
    return !content.includes("**Scope:** active");
  }

  // Reactive-execute: verify that each dispatched task's summary exists.
  // The unitId encodes the batch: "{mid}/{sid}/reactive+T02,T03"
  if (unitType === "reactive-execute") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;
    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) {
      // Legacy format "reactive" without batch IDs — fall back to "any summary"
      const tDir = resolveTasksDir(base, mid, sid);
      if (!tDir) return false;
      const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
      return summaryFiles.length > 0;
    }

    const batchIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (batchIds.length === 0) return false;

    const tDir = resolveTasksDir(base, mid, sid);
    if (!tDir) return false;

    const existingSummaries = new Set(
      resolveTaskFiles(tDir, "SUMMARY").map((f) =>
        f.replace(/-SUMMARY\.md$/i, "").toUpperCase(),
      ),
    );

    // Every dispatched task must have a summary file
    for (const tid of batchIds) {
      if (!existingSummaries.has(tid.toUpperCase())) return false;
    }
    return true;
  }

  // Gate-evaluate: verify that each dispatched gate has been resolved in the DB.
  // The unitId encodes the batch: "{mid}/{sid}/gates+Q3,Q4"
  if (unitType === "gate-evaluate") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;

    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) return true; // no specific gates encoded — pass

    const gateIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (gateIds.length === 0) return true;

    try {
      const pending = getPendingGates(mid, sid, "slice");
      const pendingIds = new Set(pending.map((g: any) => g.gate_id));
      // All dispatched gates must no longer be pending
      for (const gid of gateIds) {
        if (pendingIds.has(gid)) return false;
      }
    } catch (err) {
      // DB unavailable — treat as verified to avoid blocking
      logWarning("recovery", `gate-evaluate DB check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  // For unit types with no verifiable artifact (null path), the parent directory
  // is missing on disk — treat as stale completion state so the key gets evicted (#313).
  if (!absPath) return false;
  if (!existsSync(absPath)) return false;

  if (unitType === "validate-milestone") {
    const validationContent = readFileSync(absPath, "utf-8");
    if (!isValidationTerminal(validationContent)) return false;
  }

  if (unitType === "plan-milestone") {
    try {
      const roadmap = parseLegacyRoadmap(readFileSync(absPath, "utf-8"));
      if (roadmap.slices.length === 0) return false;
    } catch (err) {
      logWarning("recovery", `plan-milestone roadmap verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // plan-slice must produce a plan with actual task entries, not just a scaffold.
  // The plan file may exist from a prior discussion/context step with only headings
  // but no tasks. Without this check the artifact is considered "complete" and the
  // unit gets skipped — but deriveState still returns phase:"planning" because the
  // plan has no tasks, creating an infinite skip loop (#699).
  if (unitType === "plan-slice") {
    const planContent = readFileSync(absPath, "utf-8");
    // Accept checkbox-style (- [x] **T01: ...) or heading-style (### T01 -- / ### T01: / ### T01 —)
    const hasCheckboxTask = /^- \[[xX ]\] \*\*T\d+:/m.test(planContent);
    const hasHeadingTask = /^#{2,4}\s+T\d+\s*(?:--|—|:)/m.test(planContent);
    if (!hasCheckboxTask && !hasHeadingTask) return false;
  }

  // execute-task: DB status is authoritative. Fall back to checked-checkbox
  // detection when the DB is unavailable (unmigrated projects).
  if (unitType === "execute-task") {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    if (mid && sid && tid) {
      const dbTask = getTask(mid, sid, tid);
      if (dbTask) {
        // DB available — trust it
        if (dbTask.status !== "complete" && dbTask.status !== "done") return false;
      } else if (!isDbAvailable()) {
        // LEGACY: Pre-migration fallback for projects without DB.
        // Require a CHECKED checkbox — a bare heading or unchecked checkbox
        // does not prove gsd_complete_task ran. Summary file on disk alone
        // is not sufficient evidence (could be a rogue write) (#3607).
        const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
        if (planAbs && existsSync(planAbs)) {
          const planContent = readFileSync(planAbs, "utf-8");
          const escapedTid = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const cbRe = new RegExp(`^- \\[[xX]\\] \\*\\*${escapedTid}:`, "m");
          if (!cbRe.test(planContent)) return false;
        } else {
          return false; // no plan file → cannot verify
        }
      } else {
        // DB available but task row not found — completion tool never ran (#3607)
        return false;
      }
    }
  }

  // plan-slice must also produce individual task plan files for every task listed
  // in the slice plan. Without this check, a plan-slice that wrote S{sid}-PLAN.md
  // but omitted T{tid}-PLAN.md files would be marked complete, causing execute-task
  // to dispatch with a missing task plan (see issue #739).
  if (unitType === "plan-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      try {
        // DB primary path — get task IDs to verify task plan files exist
        let taskIds: string[] | null = null;
        if (isDbAvailable()) {
          const tasks = getSliceTasks(mid, sid);
          if (tasks.length > 0) taskIds = tasks.map(t => t.id);
        }

        if (!taskIds) {
          // LEGACY: DB unavailable or no tasks in DB — parse plan file for task IDs
          const planContent = readFileSync(absPath, "utf-8");
          const plan = parseLegacyPlan(planContent);
          if (plan.tasks.length > 0) taskIds = plan.tasks.map((t: { id: string }) => t.id);
        }

        if (taskIds && taskIds.length > 0) {
          const tasksDir = resolveTasksDir(base, mid, sid);
          if (tasksDir) {
            for (const tid of taskIds) {
              const taskPlanFile = join(tasksDir, `${tid}-PLAN.md`);
              if (!existsSync(taskPlanFile)) return false;
            }
          }
        }
      } catch (err) {
        // Parse failure — don't block; slice plan may have non-standard format
        logWarning("recovery", `plan-slice task plan verification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // complete-slice: DB status is authoritative for whether the slice is done.
  // Fall back to file-based check (roadmap [x]) when DB is unavailable.
  if (unitType === "complete-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      const dir = resolveSlicePath(base, mid, sid);
      if (dir) {
        const uatPath = join(dir, buildSliceFileName(sid, "UAT"));
        if (!existsSync(uatPath)) return false;
      }

      const dbSlice = getSlice(mid, sid);
      if (dbSlice) {
        // DB available — trust it
        if (dbSlice.status !== "complete") return false;
      } else if (!isDbAvailable()) {
        // LEGACY: Pre-migration fallback for projects without DB.
        // Fall back to roadmap checkbox check via parsers-legacy
        const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
        if (roadmapFile && existsSync(roadmapFile)) {
          try {
            const roadmapContent = readFileSync(roadmapFile, "utf-8");
            const roadmap = parseLegacyRoadmap(roadmapContent);
            const slice = roadmap.slices.find((s) => s.id === sid);
            if (slice && !slice.done) return false;
          } catch (e) {
            logWarning("recovery", `roadmap parse failed: ${(e as Error).message}`);
            return false;
          }
        }
      }
      // else: DB available but slice not found — summary + UAT exist,
      // treat as verified (slice may not be imported yet)
    }
  }

  // complete-milestone must have produced implementation artifacts (#1703).
  // A milestone with only .gsd/ plan files and zero implementation code is
  // not genuinely complete — the LLM wrote plan files but skipped actual work.
  if (unitType === "complete-milestone") {
    if (hasImplementationArtifacts(base) === "absent") return false;
  }

  return true;
}

/**
 * Write a placeholder artifact so the pipeline can advance past a stuck unit.
 * Returns the relative path written, or null if the path couldn't be resolved.
 */
export function writeBlockerPlaceholder(
  unitType: string,
  unitId: string,
  base: string,
  reason: string,
): string | null {
  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  if (!absPath) return null;
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = [
    `# BLOCKER — auto-mode recovery failed`,
    ``,
    `Unit \`${unitType}\` for \`${unitId}\` failed to produce this artifact after idle recovery exhausted all retries.`,
    ``,
    `**Reason**: ${reason}`,
    ``,
    `This placeholder was written by auto-mode so the pipeline can advance.`,
    `Review and replace this file before relying on downstream artifacts.`,
  ].join("\n");
  writeFileSync(absPath, content, "utf-8");

  // Mark the task/slice as complete in the DB so verifyExpectedArtifact passes.
  // Without this, the DB status stays "pending" and the dispatch loop
  // re-derives the same unit indefinitely (#2531, #2653).
  if (isDbAvailable()) {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const ts = new Date().toISOString();
    if (unitType === "execute-task" && mid && sid && tid) {
      try { updateTaskStatus(mid, sid, tid, "complete", ts); } catch (e) { logWarning("recovery", `updateTaskStatus failed during context exhaustion: ${e instanceof Error ? e.message : String(e)}`); }
      // Append event so worktree reconciliation can replay this recovery completion
      try { appendEvent(base, { cmd: "complete-task", params: { milestoneId: mid, sliceId: sid, taskId: tid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" }); } catch (e) { logWarning("recovery", `appendEvent failed for task recovery: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (unitType === "complete-slice" && mid && sid) {
      try { updateSliceStatus(mid, sid, "complete", ts); } catch (e) { logWarning("recovery", `updateSliceStatus failed during context exhaustion: ${e instanceof Error ? e.message : String(e)}`); }
      try { appendEvent(base, { cmd: "complete-slice", params: { milestoneId: mid, sliceId: sid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" }); } catch (e) { logWarning("recovery", `appendEvent failed for slice recovery: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  return diagnoseExpectedArtifact(unitType, unitId, base);
}

// ─── Merge State Reconciliation ───────────────────────────────────────────────

/**
 * Best-effort abort of a pending merge/squash and hard-reset to HEAD.
 * Handles both real merges (MERGE_HEAD) and squash merges (SQUASH_MSG).
 */
function abortAndResetMerge(
  basePath: string,
  hasMergeHead: boolean,
  squashMsgPath: string,
): void {
  if (hasMergeHead) {
    try {
      nativeMergeAbort(basePath);
    } catch (err) {
      /* best-effort */
      logWarning("recovery", `git merge-abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (squashMsgPath) {
    try {
      unlinkSync(squashMsgPath);
    } catch (err) {
      /* best-effort */
      logWarning("recovery", `file unlink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    nativeResetHard(basePath);
  } catch (err) {
    /* best-effort */
    logError("recovery", `git reset failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type MergeReconcileResult = "clean" | "reconciled" | "blocked";

/**
 * Detect leftover merge state from a prior session and reconcile it.
 * If MERGE_HEAD or SQUASH_MSG exists, check whether conflicts are resolved.
 * If resolved: finalize the commit. If only .gsd conflicts remain: auto-resolve.
 * If code conflicts remain: fail safe without modifying the worktree.
 */
export function reconcileMergeState(
  basePath: string,
  ctx: ExtensionContext,
): MergeReconcileResult {
  const mergeHeadPath = join(basePath, ".git", "MERGE_HEAD");
  const squashMsgPath = join(basePath, ".git", "SQUASH_MSG");
  const hasMergeHead = existsSync(mergeHeadPath);
  const hasSquashMsg = existsSync(squashMsgPath);
  if (!hasMergeHead && !hasSquashMsg) return "clean";

  const conflictedFiles = nativeConflictFiles(basePath);
  if (conflictedFiles.length === 0) {
    // All conflicts resolved — finalize the merge/squash commit
    try {
      const commitSha = nativeCommit(basePath, "chore(gsd): reconcile merge state");
      if (commitSha) {
        const mode = hasMergeHead ? "merge" : "squash commit";
        ctx.ui.notify(`Finalized leftover ${mode} from prior session.`, "info");
      } else {
        ctx.ui.notify("No new commit needed for leftover merge/squash state — already committed.", "info");
      }
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      ctx.ui.notify(`Failed to finalize leftover merge/squash commit: ${errorMessage}`, "error");
      return "blocked";
    }
  } else {
    // Still conflicted — try auto-resolving .gsd/ state file conflicts (#530)
    const gsdConflicts = conflictedFiles.filter((f) => f.startsWith(".gsd/"));
    const codeConflicts = conflictedFiles.filter((f) => !f.startsWith(".gsd/"));

    if (gsdConflicts.length > 0 && codeConflicts.length === 0) {
      // All conflicts are in .gsd/ state files — auto-resolve by accepting theirs
      let resolved = true;
      try {
        nativeCheckoutTheirs(basePath, gsdConflicts);
        nativeAddPaths(basePath, gsdConflicts);
      } catch (e) {
        logError("recovery", `auto-resolve .gsd/ conflicts failed: ${(e as Error).message}`);
        resolved = false;
      }
      if (resolved) {
        try {
          nativeCommit(
            basePath,
            "chore: auto-resolve .gsd/ state file conflicts",
          );
          ctx.ui.notify(
            `Auto-resolved ${gsdConflicts.length} .gsd/ state file conflict(s) from prior merge.`,
            "info",
          );
        } catch (e) {
          logError("recovery", `auto-commit .gsd/ conflict resolution failed: ${(e as Error).message}`);
          resolved = false;
        }
      }
      if (!resolved) {
        abortAndResetMerge(basePath, hasMergeHead, squashMsgPath);
        ctx.ui.notify(
          "Detected leftover merge state — auto-resolve failed, cleaned up. Re-deriving state.",
          "warning",
        );
      }
    } else {
      // Code conflicts present — fail safe and preserve any manual resolution
      // work instead of discarding it with merge --abort/reset --hard.
      ctx.ui.notify(
        "Detected leftover merge state with unresolved code conflicts. Auto-mode will pause without modifying the worktree so manual conflict resolution is preserved.",
        "error",
      );
      return "blocked";
    }
  }
  return "reconciled";
}

// ─── Loop Remediation ─────────────────────────────────────────────────────────

/**
 * Build concrete, manual remediation steps for a loop-detected unit failure.
 * These are shown when automatic reconciliation is not possible.
 */
export function buildLoopRemediationSteps(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      return [
        `   1. Run \`gsd undo-task ${tid}\` to reset the task state`,
        `   2. Resume auto-mode — it will re-execute the task`,
        `   3. If the task keeps failing, run \`gsd recover\` to rebuild DB state from disk`,
      ].join("\n");
    }
    case "plan-slice":
    case "research-slice": {
      if (!mid || !sid) break;
      const artifactRel =
        unitType === "plan-slice"
          ? relSliceFile(base, mid, sid, "PLAN")
          : relSliceFile(base, mid, sid, "RESEARCH");
      return [
        `   1. Write ${artifactRel} manually (or with the LLM in interactive mode)`,
        `   2. Run \`gsd recover\` to rebuild DB state from disk`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Run \`gsd reset-slice ${sid}\` to reset the slice and all its tasks`,
        `   2. Resume auto-mode — it will re-execute incomplete tasks and re-complete the slice`,
        `   3. If the slice keeps failing, run \`gsd recover\` to rebuild DB state from disk`,
      ].join("\n");
    }
    case "validate-milestone": {
      if (!mid) break;
      const artifactRel = relMilestoneFile(base, mid, "VALIDATION");
      return [
        `   1. Write ${artifactRel} with verdict: pass`,
        `   2. Run \`gsd recover\` to rebuild DB state from disk`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
