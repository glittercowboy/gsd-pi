import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import { loadFile } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap } from "./parsers-legacy.js";
import { isDbAvailable, getMilestoneSlices } from "./gsd-db.js";
import { resolveMilestoneFile } from "./paths.js";
import { deriveState, isMilestoneComplete } from "./state.js";
import { listWorktrees, resolveGitDir, worktreesDir } from "./worktree-manager.js";
import { abortAndReset } from "./git-self-heal.js";
import { RUNTIME_EXCLUSION_PATHS, resolveMilestoneIntegrationBranch, writeIntegrationBranch } from "./git-service.js";
import { nativeIsRepo, nativeWorktreeList, nativeWorktreeRemove, nativeBranchList, nativeBranchDelete, nativeLsFiles, nativeRmCached } from "./native-git-bridge.js";
import { getAllWorktreeHealth } from "./worktree-health.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

/**
 * Returns true if the directory contains only doctor artifacts
 * (e.g. `.gsd/doctor-history.jsonl`). These dirs are created by
 * appendDoctorHistory() writing to worktree-scoped paths during the audit
 * and should not be flagged as orphaned worktrees (#3105).
 */
function isDoctorArtifactOnly(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);
    // Empty dir — not a doctor artifact, still orphaned
    if (entries.length === 0) return false;
    // Only a .gsd subdirectory
    if (entries.length === 1 && entries[0] === ".gsd") {
      const gsdEntries = readdirSync(join(dirPath, ".gsd"));
      return gsdEntries.length <= 1 && gsdEntries.every(e => e === "doctor-history.jsonl");
    }
    return false;
  } catch {
    return false;
  }
}

export async function checkGitHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
  isolationMode: "none" | "worktree" | "branch" = "none",
): Promise<void> {
  // Degrade gracefully if not a git repo
  if (!nativeIsRepo(basePath)) {
    return; // Not a git repo — skip all git health checks
  }

  const gitDir = resolveGitDir(basePath);

  // ── Orphaned auto-worktrees & Stale milestone branches ────────────────
  // These checks only apply in worktree/branch modes — skip in none mode
  // where no milestone worktrees or branches are created.
  if (isolationMode !== "none") {
  try {
    const worktrees = listWorktrees(basePath);
    const milestoneWorktrees = worktrees.filter(wt => wt.branch.startsWith("milestone/"));

    // Load roadmap state once for cross-referencing
    const state = await deriveState(basePath);

    for (const wt of milestoneWorktrees) {
      // Extract milestone ID from branch name "milestone/M001" → "M001"
      const milestoneId = wt.branch.replace(/^milestone\//, "");
      const milestoneEntry = state.registry.find(m => m.id === milestoneId);

      // Check if milestone is complete via roadmap
      let isComplete = false;
      if (milestoneEntry) {
        if (isDbAvailable()) {
          const dbSlices = getMilestoneSlices(milestoneId);
          isComplete = dbSlices.length > 0 && dbSlices.every(s => s.status === "complete");
        } else {
          const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
          const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
          if (roadmapContent) {
            const roadmap = parseLegacyRoadmap(roadmapContent);
            isComplete = isMilestoneComplete(roadmap);
          }
        }
        // When DB unavailable and no roadmap, isComplete stays false
      }

      if (isComplete) {
        issues.push({
          severity: "warning",
          code: "orphaned_auto_worktree",
          scope: "milestone",
          unitId: milestoneId,
          message: `Worktree for completed milestone ${milestoneId} still exists at ${wt.path}`,
          fixable: true,
        });

        if (shouldFix("orphaned_auto_worktree")) {
          // If cwd is inside the worktree, chdir out first — matching the
          // pattern in removeWorktree() (#1946). Without this, git cannot
          // remove the worktree and the doctor enters a deadlock where it
          // detects the orphan every run but never cleans it up.
          const cwd = process.cwd();
          if (wt.path === cwd || cwd.startsWith(wt.path + sep)) {
            try {
              process.chdir(basePath);
            } catch {
              fixesApplied.push(`skipped removing worktree at ${wt.path} (cannot chdir to basePath)`);
              continue;
            }
          }
          try {
            nativeWorktreeRemove(basePath, wt.path, true);
            fixesApplied.push(`removed orphaned worktree ${wt.path}`);
          } catch {
            fixesApplied.push(`failed to remove worktree ${wt.path}`);
          }
        }
      }
    }

    // ── Stale milestone branches ─────────────────────────────────────────
    try {
      const branches = nativeBranchList(basePath, "milestone/*");
      if (branches.length > 0) {
        const worktreeBranches = new Set(milestoneWorktrees.map(wt => wt.branch));

        for (const branch of branches) {
          // Skip branches that have a worktree (handled above)
          if (worktreeBranches.has(branch)) continue;

          const milestoneId = branch.replace(/^milestone\//, "");
          const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
          let branchMilestoneComplete = false;
          if (isDbAvailable()) {
            const dbSlices = getMilestoneSlices(milestoneId);
            branchMilestoneComplete = dbSlices.length > 0 && dbSlices.every(s => s.status === "complete");
          } else {
            const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
            if (!roadmapContent) continue;
            const roadmap = parseLegacyRoadmap(roadmapContent);
            branchMilestoneComplete = isMilestoneComplete(roadmap);
          }
          if (branchMilestoneComplete) {
            issues.push({
              severity: "info",
              code: "stale_milestone_branch",
              scope: "milestone",
              unitId: milestoneId,
              message: `Branch ${branch} exists for completed milestone ${milestoneId}`,
              fixable: true,
            });

            if (shouldFix("stale_milestone_branch")) {
              try {
                nativeBranchDelete(basePath, branch, true);
                fixesApplied.push(`deleted stale branch ${branch}`);
              } catch {
                fixesApplied.push(`failed to delete branch ${branch}`);
              }
            }
          }
        }
      }
    } catch {
      // git branch list failed — skip stale branch check
    }
  } catch {
    // listWorktrees or deriveState failed — skip worktree/branch checks
  }
  } // end isolationMode !== "none"

  // ── Corrupt merge state ────────────────────────────────────────────────
  try {
    const mergeStateFiles = ["MERGE_HEAD", "SQUASH_MSG"];
    const mergeStateDirs = ["rebase-apply", "rebase-merge"];
    const found: string[] = [];

    for (const f of mergeStateFiles) {
      if (existsSync(join(gitDir, f))) found.push(f);
    }
    for (const d of mergeStateDirs) {
      if (existsSync(join(gitDir, d))) found.push(d);
    }

    if (found.length > 0) {
      issues.push({
        severity: "error",
        code: "corrupt_merge_state",
        scope: "project",
        unitId: "project",
        message: `Corrupt merge/rebase state detected: ${found.join(", ")}`,
        fixable: true,
      });

      if (shouldFix("corrupt_merge_state")) {
        const result = abortAndReset(basePath);
        fixesApplied.push(`cleaned merge state: ${result.cleaned.join(", ")}`);
      }
    }
  } catch {
    // Can't check .git dir — skip
  }

  // ── Tracked runtime files ──────────────────────────────────────────────
  try {
    const trackedPaths: string[] = [];
    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      try {
        const files = nativeLsFiles(basePath, exclusion);
        if (files.length > 0) {
          trackedPaths.push(...files);
        }
      } catch {
        // Individual ls-files can fail — continue
      }
    }

    if (trackedPaths.length > 0) {
      issues.push({
        severity: "warning",
        code: "tracked_runtime_files",
        scope: "project",
        unitId: "project",
        message: `${trackedPaths.length} runtime file(s) are tracked by git: ${trackedPaths.slice(0, 5).join(", ")}${trackedPaths.length > 5 ? "..." : ""}`,
        fixable: true,
      });

      if (shouldFix("tracked_runtime_files")) {
        try {
          for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
            nativeRmCached(basePath, [exclusion]);
          }
          fixesApplied.push(`untracked ${trackedPaths.length} runtime file(s)`);
        } catch {
          fixesApplied.push("failed to untrack runtime files");
        }
      }
    }
  } catch {
    // git ls-files failed — skip
  }

  // ── Legacy slice branches ──────────────────────────────────────────────
  try {
    const branchList = nativeBranchList(basePath, "gsd/*/*")
      .filter((branch) => !branch.startsWith("gsd/quick/"));
    if (branchList.length > 0) {
      issues.push({
        severity: "info",
        code: "legacy_slice_branches",
        scope: "project",
        unitId: "project",
        message: `${branchList.length} legacy slice branch(es) found: ${branchList.slice(0, 3).join(", ")}${branchList.length > 3 ? "..." : ""}. These are no longer used (branchless architecture).`,
        fixable: true,
      });

      if (shouldFix("legacy_slice_branches")) {
        let deleted = 0;
        for (const branch of branchList) {
          try {
            nativeBranchDelete(basePath, branch, true);
            deleted++;
          } catch { /* skip branches that can't be deleted */ }
        }
        if (deleted > 0) {
          fixesApplied.push(`deleted ${deleted} legacy slice branch(es)`);
        }
      }
    }
  } catch {
    // git branch list failed — skip
  }

  // ── Integration branch existence ──────────────────────────────────────
  // For each active (non-complete) milestone, verify the stored integration
  // branch still exists in git. A missing integration branch blocks merge-back
  // and causes the next merge operation to fail silently.
  try {
    const state = await deriveState(basePath);
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
    for (const milestone of state.registry) {
      if (milestone.status === "complete") continue;
      const resolution = resolveMilestoneIntegrationBranch(basePath, milestone.id, gitPrefs);
      if (!resolution.recordedBranch) continue; // No stored branch — skip (not yet set)
      if (resolution.status === "fallback" && resolution.effectiveBranch) {
        issues.push({
          severity: "warning",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: resolution.reason,
          fixable: true,
        });
        if (shouldFix("integration_branch_missing")) {
          writeIntegrationBranch(basePath, milestone.id, resolution.effectiveBranch);
          fixesApplied.push(`updated integration branch for ${milestone.id} to "${resolution.effectiveBranch}"`);
        }
        continue;
      }

      if (resolution.status === "missing") {
        issues.push({
          severity: "error",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: resolution.reason,
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — integration branch check failed
  }

  // ── Orphaned worktree directories ────────────────────────────────────
  // Worktree removal can fail after a branch delete, leaving a directory
  // that is no longer registered with git. These orphaned dirs cause
  // "already exists" errors when re-creating the same worktree name.
  try {
    const wtDir = worktreesDir(basePath);
    if (existsSync(wtDir)) {
      // Resolve symlinks and normalize separators so that symlinked .gsd
      // paths (e.g. ~/.gsd/projects/<hash>/worktrees/…) match the paths
      // returned by `git worktree list`.
      const normalizePath = (p: string): string => {
        try { p = realpathSync(p); } catch { /* path may not exist */ }
        return p.replaceAll("\\", "/");
      };
      const registeredPaths = new Set(
        nativeWorktreeList(basePath).map(entry => normalizePath(entry.path)),
      );
      for (const entry of readdirSync(wtDir)) {
        const fullPath = join(wtDir, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch { continue; }
        const normalizedFullPath = normalizePath(fullPath);
        if (!registeredPaths.has(normalizedFullPath)) {
          // Skip directories that only contain doctor artifacts (.gsd/doctor-history.jsonl).
          // appendDoctorHistory() can recreate these dirs during the audit itself,
          // causing a circular false positive (#3105 Bug 1).
          if (isDoctorArtifactOnly(fullPath)) continue;
          issues.push({
            severity: "warning",
            code: "worktree_directory_orphaned",
            scope: "project",
            unitId: entry,
            message: `Worktree directory ${fullPath} exists on disk but is not registered with git. Run "git worktree prune" or doctor --fix to remove it.`,
            fixable: true,
          });
          if (shouldFix("worktree_directory_orphaned")) {
            try {
              rmSync(fullPath, { recursive: true, force: true });
              fixesApplied.push(`removed orphaned worktree directory ${fullPath}`);
            } catch {
              fixesApplied.push(`failed to remove orphaned worktree directory ${fullPath}`);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — orphaned worktree directory check failed
  }

  // ── Worktree lifecycle checks ──────────────────────────────────────────
  // Check GSD-managed worktrees for: merged branches, stale work, dirty
  // state, and unpushed commits. Only worktrees under .gsd/worktrees/.
  try {
    const healthStatuses = getAllWorktreeHealth(basePath);
    const cwd = process.cwd();

    for (const health of healthStatuses) {
      const wt = health.worktree;
      const isCwd = wt.path === cwd || cwd.startsWith(wt.path + sep);

      // Branch fully merged into main — safe to remove
      if (health.mergedIntoMain) {
        issues.push({
          severity: "info",
          code: "worktree_branch_merged",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" (branch ${wt.branch}) is fully merged into main${health.safeToRemove ? " — safe to remove" : ""}`,
          fixable: health.safeToRemove,
        });

        if (health.safeToRemove && shouldFix("worktree_branch_merged") && !isCwd) {
          try {
            const { removeWorktree } = await import("./worktree-manager.js");
            removeWorktree(basePath, wt.name, { deleteBranch: true, branch: wt.branch });
            fixesApplied.push(`removed merged worktree "${wt.name}" and deleted branch ${wt.branch}`);
          } catch {
            fixesApplied.push(`failed to remove merged worktree "${wt.name}"`);
          }
        }
        // If merged, skip the stale/dirty/unpushed checks — they're irrelevant
        continue;
      }

      // Stale: no commits in N days, not merged
      if (health.stale) {
        const days = Math.floor(health.lastCommitAgeDays);
        issues.push({
          severity: "warning",
          code: "worktree_stale",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has had no commits in ${days} day${days === 1 ? "" : "s"}`,
          fixable: false,
        });
      }

      // Dirty: uncommitted changes in a worktree (only flag on stale worktrees to avoid noise)
      if (health.dirty && health.stale) {
        issues.push({
          severity: "warning",
          code: "worktree_dirty",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has ${health.dirtyFileCount} uncommitted file${health.dirtyFileCount === 1 ? "" : "s"} and is stale`,
          fixable: false,
        });
      }

      // Unpushed: commits not on any remote (only flag on stale worktrees to avoid noise)
      if (health.unpushedCommits > 0 && health.stale) {
        issues.push({
          severity: "warning",
          code: "worktree_unpushed",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has ${health.unpushedCommits} unpushed commit${health.unpushedCommits === 1 ? "" : "s"}`,
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — worktree lifecycle check failed
  }
}
