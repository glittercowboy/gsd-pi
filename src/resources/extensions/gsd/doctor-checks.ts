import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import { loadFile, parseRoadmap } from "./files.js";
import { resolveMilestoneFile, milestonesDir, gsdRoot, resolveGsdRootFile, relGsdRootFile } from "./paths.js";
import { deriveState, isMilestoneComplete } from "./state.js";
import { saveFile } from "./files.js";
import { listWorktrees, resolveGitDir, worktreesDir } from "./worktree-manager.js";
import { abortAndReset } from "./git-self-heal.js";
import { RUNTIME_EXCLUSION_PATHS, readIntegrationBranch } from "./git-service.js";
import { nativeIsRepo, nativeBranchExists, nativeWorktreeList, nativeWorktreeRemove, nativeBranchList, nativeBranchDelete, nativeLsFiles, nativeRmCached } from "./native-git-bridge.js";
import { readCrashLock, isLockProcessAlive, clearLock } from "./crash-recovery.js";
import { ensureGitignore } from "./gitignore.js";
import { readAllSessionStatuses, isSessionStale, removeSessionStatus } from "./session-status-io.js";
import { recoverFailedMigration } from "./migrate-external.js";

export async function checkGitHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
  isolationMode: "none" | "worktree" | "branch" = "worktree",
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
        const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
        const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
        if (roadmapContent) {
          const roadmap = parseRoadmap(roadmapContent);
          isComplete = isMilestoneComplete(roadmap);
        }
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
          // Never remove a worktree matching current working directory
          const cwd = process.cwd();
          if (wt.path === cwd || cwd.startsWith(wt.path + sep)) {
            fixesApplied.push(`skipped removing worktree at ${wt.path} (is cwd)`);
          } else {
            try {
              nativeWorktreeRemove(basePath, wt.path, true);
              fixesApplied.push(`removed orphaned worktree ${wt.path}`);
            } catch {
              fixesApplied.push(`failed to remove worktree ${wt.path}`);
            }
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
          const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
          if (!roadmapContent) continue;

          const roadmap = parseRoadmap(roadmapContent);
          if (isMilestoneComplete(roadmap)) {
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
    const branchList = nativeBranchList(basePath, "gsd/*/*");
    if (branchList.length > 0) {
      issues.push({
        severity: "info",
        code: "legacy_slice_branches",
        scope: "project",
        unitId: "project",
        message: `${branchList.length} legacy slice branch(es) found: ${branchList.slice(0, 3).join(", ")}${branchList.length > 3 ? "..." : ""}. These are no longer used (branchless architecture). Delete with: git branch -D ${branchList.join(" ")}`,
        fixable: false,
      });
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
    for (const milestone of state.registry) {
      if (milestone.status === "complete") continue;
      const integrationBranch = readIntegrationBranch(basePath, milestone.id);
      if (!integrationBranch) continue; // No stored branch — skip (not yet set)
      if (!nativeBranchExists(basePath, integrationBranch)) {
        issues.push({
          severity: "error",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: `Milestone ${milestone.id} recorded integration branch "${integrationBranch}" but that branch no longer exists in git. Merge-back will fail.`,
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
      const registeredPaths = new Set(
        nativeWorktreeList(basePath).map(entry => entry.path),
      );
      for (const entry of readdirSync(wtDir)) {
        const fullPath = join(wtDir, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch { continue; }
        if (!registeredPaths.has(fullPath)) {
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
}

// ── Runtime Health Checks ──────────────────────────────────────────────────
// Checks for stale crash locks, orphaned completed-units, stale hook state,
// activity log bloat, STATE.md drift, and gitignore drift.

export async function checkRuntimeHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
): Promise<void> {
  const root = gsdRoot(basePath);

  // ── Stale crash lock ──────────────────────────────────────────────────
  try {
    const lock = readCrashLock(basePath);
    if (lock) {
      const alive = isLockProcessAlive(lock);
      if (!alive) {
        issues.push({
          severity: "error",
          code: "stale_crash_lock",
          scope: "project",
          unitId: "project",
          message: `Stale auto.lock from PID ${lock.pid} (started ${lock.startedAt}, was executing ${lock.unitType} ${lock.unitId}) — process is no longer running`,
          file: ".gsd/auto.lock",
          fixable: true,
        });

        if (shouldFix("stale_crash_lock")) {
          clearLock(basePath);
          fixesApplied.push("cleared stale auto.lock");
        }
      }
    }
  } catch {
    // Non-fatal — crash lock check failed
  }

  // ── Stranded lock directory ────────────────────────────────────────────
  // proper-lockfile creates a `.gsd.lock/` directory as the OS-level lock
  // mechanism. If the process was SIGKILLed or crashed hard, this directory
  // can remain on disk without any live process holding it. The next session
  // fails to acquire the lock until the directory is removed (#1245).
  try {
    const lockDir = join(dirname(root), `${basename(root)}.lock`);
    if (existsSync(lockDir)) {
      const statRes = statSync(lockDir);
      if (statRes.isDirectory()) {
        // Check if any live process actually holds this lock
        const lock = readCrashLock(basePath);
        const lockHolderAlive = lock ? isLockProcessAlive(lock) : false;
        if (!lockHolderAlive) {
          issues.push({
            severity: "error",
            code: "stranded_lock_directory",
            scope: "project",
            unitId: "project",
            message: `Stranded lock directory "${lockDir}" exists but no live process holds the session lock. This blocks new auto-mode sessions from starting.`,
            file: lockDir,
            fixable: true,
          });
          if (shouldFix("stranded_lock_directory")) {
            try {
              rmSync(lockDir, { recursive: true, force: true });
              fixesApplied.push(`removed stranded lock directory ${lockDir}`);
            } catch {
              fixesApplied.push(`failed to remove stranded lock directory ${lockDir}`);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — stranded lock directory check failed
  }

  // ── Stale parallel sessions ────────────────────────────────────────────
  try {
    const parallelStatuses = readAllSessionStatuses(basePath);
    for (const status of parallelStatuses) {
      if (isSessionStale(status)) {
        issues.push({
          severity: "warning",
          code: "stale_parallel_session",
          scope: "project",
          unitId: status.milestoneId,
          message: `Stale parallel session for ${status.milestoneId} (PID ${status.pid}, started ${new Date(status.startedAt).toISOString()}, last heartbeat ${new Date(status.lastHeartbeat).toISOString()}) — process is no longer running`,
          file: `.gsd/parallel/${status.milestoneId}.status.json`,
          fixable: true,
        });

        if (shouldFix("stale_parallel_session")) {
          removeSessionStatus(basePath, status.milestoneId);
          fixesApplied.push(`cleaned up stale parallel session for ${status.milestoneId}`);
        }
      }
    }
  } catch {
    // Non-fatal — parallel session check failed
  }

  // ── Orphaned completed-units keys ─────────────────────────────────────
  try {
    const completedKeysFile = join(root, "completed-units.json");
    if (existsSync(completedKeysFile)) {
      const raw = readFileSync(completedKeysFile, "utf-8");
      const keys: string[] = JSON.parse(raw);
      const orphaned: string[] = [];

      for (const key of keys) {
        // Key format: "unitType/unitId" e.g. "execute-task/M001/S01/T01"
        const slashIdx = key.indexOf("/");
        if (slashIdx === -1) continue;
        const unitType = key.slice(0, slashIdx);
        const unitId = key.slice(slashIdx + 1);

        // Only validate artifact-producing unit types
        const { verifyExpectedArtifact } = await import("./auto-recovery.js");
        if (!verifyExpectedArtifact(unitType, unitId, basePath)) {
          orphaned.push(key);
        }
      }

      if (orphaned.length > 0) {
        issues.push({
          severity: "warning",
          code: "orphaned_completed_units",
          scope: "project",
          unitId: "project",
          message: `${orphaned.length} completed-unit key(s) reference missing artifacts: ${orphaned.slice(0, 3).join(", ")}${orphaned.length > 3 ? "..." : ""}`,
          file: ".gsd/completed-units.json",
          fixable: true,
        });

        if (shouldFix("orphaned_completed_units")) {
          const orphanedSet = new Set(orphaned);
          const remaining = keys.filter((key) => !orphanedSet.has(key));
          await saveFile(completedKeysFile, JSON.stringify(remaining));
          fixesApplied.push(`removed ${orphaned.length} orphaned completed-unit key(s)`);
        }
      }
    }
  } catch {
    // Non-fatal — completed-units check failed
  }

  // ── Stale hook state ──────────────────────────────────────────────────
  try {
    const hookStateFile = join(root, "hook-state.json");
    if (existsSync(hookStateFile)) {
      const raw = readFileSync(hookStateFile, "utf-8");
      const state = JSON.parse(raw);
      const hasCycleCounts = state.cycleCounts && typeof state.cycleCounts === "object"
        && Object.keys(state.cycleCounts).length > 0;

      // Only flag if there are actual cycle counts AND no auto-mode is running
      if (hasCycleCounts) {
        const lock = readCrashLock(basePath);
        const autoRunning = lock ? isLockProcessAlive(lock) : false;

        if (!autoRunning) {
          issues.push({
            severity: "info",
            code: "stale_hook_state",
            scope: "project",
            unitId: "project",
            message: `hook-state.json has ${Object.keys(state.cycleCounts).length} residual cycle count(s) from a previous session`,
            file: ".gsd/hook-state.json",
            fixable: true,
          });

          if (shouldFix("stale_hook_state")) {
            const { clearPersistedHookState } = await import("./post-unit-hooks.js");
            clearPersistedHookState(basePath);
            fixesApplied.push("cleared stale hook-state.json");
          }
        }
      }
    }
  } catch {
    // Non-fatal — hook state check failed
  }

  // ── Activity log bloat ────────────────────────────────────────────────
  try {
    const activityDir = join(root, "activity");
    if (existsSync(activityDir)) {
      const files = readdirSync(activityDir);
      let totalSize = 0;
      for (const f of files) {
        try {
          totalSize += statSync(join(activityDir, f)).size;
        } catch {
          // stat failed — skip
        }
      }

      const totalMB = totalSize / (1024 * 1024);
      const BLOAT_FILE_THRESHOLD = 500;
      const BLOAT_SIZE_MB = 100;

      if (files.length > BLOAT_FILE_THRESHOLD || totalMB > BLOAT_SIZE_MB) {
        issues.push({
          severity: "warning",
          code: "activity_log_bloat",
          scope: "project",
          unitId: "project",
          message: `Activity logs: ${files.length} files, ${totalMB.toFixed(1)}MB (thresholds: ${BLOAT_FILE_THRESHOLD} files / ${BLOAT_SIZE_MB}MB)`,
          file: ".gsd/activity/",
          fixable: true,
        });

        if (shouldFix("activity_log_bloat")) {
          const { pruneActivityLogs } = await import("./activity-log.js");
          pruneActivityLogs(activityDir, 7); // 7-day retention
          fixesApplied.push("pruned activity logs (7-day retention)");
        }
      }
    }
  } catch {
    // Non-fatal — activity log check failed
  }

  // ── STATE.md health ───────────────────────────────────────────────────
  try {
    const stateFilePath = resolveGsdRootFile(basePath, "STATE");
    const milestonesPath = milestonesDir(basePath);

    if (existsSync(milestonesPath)) {
      if (!existsSync(stateFilePath)) {
        issues.push({
          severity: "warning",
          code: "state_file_missing",
          scope: "project",
          unitId: "project",
          message: "STATE.md is missing — state display will not work",
          file: ".gsd/STATE.md",
          fixable: true,
        });

        if (shouldFix("state_file_missing")) {
          const state = await deriveState(basePath);
          await saveFile(stateFilePath, buildStateMarkdownForCheck(state));
          fixesApplied.push("created STATE.md from derived state");
        }
      } else {
        // Check if STATE.md is stale by comparing active milestone/slice/phase
        const currentContent = readFileSync(stateFilePath, "utf-8");
        const state = await deriveState(basePath);
        const freshContent = buildStateMarkdownForCheck(state);

        // Extract key fields for comparison — don't compare full content
        // since timestamp/formatting differences are normal
        const extractFields = (content: string) => {
          const milestone = content.match(/\*\*Active Milestone:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
          const slice = content.match(/\*\*Active Slice:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
          const phase = content.match(/\*\*Phase:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
          return { milestone, slice, phase };
        };

        const current = extractFields(currentContent);
        const fresh = extractFields(freshContent);

        if (current.milestone !== fresh.milestone || current.slice !== fresh.slice || current.phase !== fresh.phase) {
          issues.push({
            severity: "warning",
            code: "state_file_stale",
            scope: "project",
            unitId: "project",
            message: `STATE.md is stale — shows "${current.phase}" but derived state is "${fresh.phase}"`,
            file: ".gsd/STATE.md",
            fixable: true,
          });

          if (shouldFix("state_file_stale")) {
            await saveFile(stateFilePath, freshContent);
            fixesApplied.push("rebuilt STATE.md from derived state");
          }
        }
      }
    }
  } catch {
    // Non-fatal — STATE.md check failed
  }

  // ── Gitignore drift ───────────────────────────────────────────────────
  try {
    const gitignorePath = join(basePath, ".gitignore");
    if (existsSync(gitignorePath) && nativeIsRepo(basePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      const existingLines = new Set(
        content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")),
      );

      // Check for critical runtime patterns that must be present
      const criticalPatterns = [
        ".gsd/activity/",
        ".gsd/runtime/",
        ".gsd/auto.lock",
        ".gsd/gsd.db",
        ".gsd/completed-units.json",
      ];

      // If blanket .gsd/ or .gsd is present, all patterns are covered
      const hasBlanketIgnore = existingLines.has(".gsd/") || existingLines.has(".gsd");

      if (!hasBlanketIgnore) {
        const missing = criticalPatterns.filter(p => !existingLines.has(p));
        if (missing.length > 0) {
          issues.push({
            severity: "warning",
            code: "gitignore_missing_patterns",
            scope: "project",
            unitId: "project",
            message: `${missing.length} critical GSD runtime pattern(s) missing from .gitignore: ${missing.join(", ")}`,
            file: ".gitignore",
            fixable: true,
          });

          if (shouldFix("gitignore_missing_patterns")) {
            ensureGitignore(basePath);
            fixesApplied.push("added missing GSD runtime patterns to .gitignore");
          }
        }
      }
    }
  } catch {
    // Non-fatal — gitignore check failed
  }

  // ── External state symlink health ──────────────────────────────────────
  try {
    const localGsd = join(basePath, ".gsd");
    if (existsSync(localGsd)) {
      const stat = lstatSync(localGsd);

      // Check for .gsd.migrating (failed migration)
      const migratingPath = join(basePath, ".gsd.migrating");
      if (existsSync(migratingPath)) {
        issues.push({
          severity: "error",
          code: "failed_migration",
          scope: "project",
          unitId: "project",
          message: "Found .gsd.migrating — a previous external state migration failed. State may be incomplete.",
          file: ".gsd.migrating",
          fixable: true,
        });

        if (shouldFix("failed_migration")) {
          if (recoverFailedMigration(basePath)) {
            fixesApplied.push("recovered failed migration (.gsd.migrating → .gsd)");
          }
        }
      }

      // Check symlink target exists
      if (stat.isSymbolicLink()) {
        try {
          realpathSync(localGsd);
        } catch {
          issues.push({
            severity: "error",
            code: "broken_symlink",
            scope: "project",
            unitId: "project",
            message: ".gsd symlink target does not exist. External state directory may have been deleted.",
            file: ".gsd",
            fixable: false,
          });
        }
      }
    }
  } catch {
    // Non-fatal — external state check failed
  }

  // ── Metrics ledger integrity ───────────────────────────────────────────
  try {
    const metricsPath = join(root, "metrics.json");
    if (existsSync(metricsPath)) {
      try {
        const raw = readFileSync(metricsPath, "utf-8");
        const ledger = JSON.parse(raw);
        if (ledger.version !== 1 || !Array.isArray(ledger.units)) {
          issues.push({
            severity: "warning",
            code: "metrics_ledger_corrupt",
            scope: "project",
            unitId: "project",
            message: "metrics.json has an unexpected structure (version !== 1 or units is not an array) — metrics data may be unreliable",
            file: ".gsd/metrics.json",
            fixable: false,
          });
        }
      } catch {
        issues.push({
          severity: "warning",
          code: "metrics_ledger_corrupt",
          scope: "project",
          unitId: "project",
          message: "metrics.json is not valid JSON — metrics data may be corrupt",
          file: ".gsd/metrics.json",
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — metrics check failed
  }

  // ── Large planning file detection ──────────────────────────────────────
  // Files over 100KB can cause LLM context pressure. Report the worst offenders.
  try {
    const MAX_FILE_BYTES = 100 * 1024; // 100KB
    const milestonesPath = milestonesDir(basePath);
    if (existsSync(milestonesPath)) {
      const largeFiles: Array<{ path: string; sizeKB: number }> = [];
      function scanForLargeFiles(dir: string, depth = 0): void {
        if (depth > 6) return;
        try {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            try {
              const s = statSync(full);
              if (s.isDirectory()) { scanForLargeFiles(full, depth + 1); continue; }
              if (entry.endsWith(".md") && s.size > MAX_FILE_BYTES) {
                largeFiles.push({ path: full.replace(basePath + "/", ""), sizeKB: Math.round(s.size / 1024) });
              }
            } catch { /* skip entry */ }
          }
        } catch { /* skip dir */ }
      }
      scanForLargeFiles(milestonesPath);
      if (largeFiles.length > 0) {
        largeFiles.sort((a, b) => b.sizeKB - a.sizeKB);
        const worst = largeFiles[0]!;
        issues.push({
          severity: "warning",
          code: "large_planning_file",
          scope: "project",
          unitId: "project",
          message: `${largeFiles.length} planning file(s) exceed 100KB — largest: ${worst.path} (${worst.sizeKB}KB). Large files cause LLM context pressure.`,
          file: worst.path,
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — large file scan failed
  }
}

/**
 * Build STATE.md markdown content from derived state.
 * Local helper used by checkRuntimeHealth for STATE.md drift detection and repair.
 */
function buildStateMarkdownForCheck(state: Awaited<ReturnType<typeof deriveState>>): string {
  const lines: string[] = [];
  lines.push("# GSD State", "");

  const activeMilestone = state.activeMilestone
    ? `${state.activeMilestone.id}: ${state.activeMilestone.title}`
    : "None";
  const activeSlice = state.activeSlice
    ? `${state.activeSlice.id}: ${state.activeSlice.title}`
    : "None";

  lines.push(`**Active Milestone:** ${activeMilestone}`);
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active · ${state.requirements.validated} validated · ${state.requirements.deferred} deferred · ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");

  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\uD83D\uDD04" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${entry.title}`);
  }

  lines.push("");
  lines.push("## Recent Decisions");
  if (state.recentDecisions.length > 0) {
    for (const decision of state.recentDecisions) lines.push(`- ${decision}`);
  } else {
    lines.push("- None recorded");
  }

  lines.push("");
  lines.push("## Blockers");
  if (state.blockers.length > 0) {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push("- None");
  }

  lines.push("");
  lines.push("## Next Action");
  lines.push(state.nextAction || "None");
  lines.push("");

  return lines.join("\n");
}
