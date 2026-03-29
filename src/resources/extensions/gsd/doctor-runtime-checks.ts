import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import { cleanNumberedGsdVariants } from "./repo-identity.js";
import { milestonesDir, gsdRoot, resolveGsdRootFile } from "./paths.js";
import { deriveState } from "./state.js";
import { saveFile } from "./files.js";
import { nativeIsRepo, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";
import { readCrashLock, isLockProcessAlive, clearLock } from "./crash-recovery.js";
import { ensureGitignore } from "./gitignore.js";
import { readAllSessionStatuses, isSessionStale, removeSessionStatus } from "./session-status-io.js";
import { recoverFailedMigration } from "./migrate-external.js";

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
        // Hook units have compound types: "hook/<hookName>/unitId"
        const { splitCompletedKey } = await import("./forensics.js");
        const parsed = splitCompletedKey(key);
        if (!parsed) continue;
        const { unitType, unitId } = parsed;

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

      // Check for critical runtime patterns that must be present.
      // NOTE: GSD_RUNTIME_PATTERNS in gitignore.ts is the canonical source of truth.
      // This is a minimal subset for the doctor check.
      const criticalPatterns = [
        ".gsd/activity/",
        ".gsd/runtime/",
        ".gsd/auto.lock",
        ".gsd/gsd.db*",
        ".gsd/completed-units*.json",
        ".gsd/event-log.jsonl",
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

  // ── Numbered .gsd collision variants (#2205) ───────────────────────────
  // macOS APFS can create ".gsd 2", ".gsd 3" etc. when a directory blocks
  // symlink creation. These must be removed so the canonical .gsd is used.
  try {
    const variantPattern = /^\.gsd \d+$/;
    const entries = readdirSync(basePath);
    const variants = entries.filter(e => variantPattern.test(e));
    if (variants.length > 0) {
      for (const v of variants) {
        issues.push({
          severity: "warning",
          code: "numbered_gsd_variant",
          scope: "project",
          unitId: "project",
          message: `Found macOS collision variant "${v}" — this can cause GSD state to appear deleted.`,
          file: v,
          fixable: true,
        });
      }

      if (shouldFix("numbered_gsd_variant")) {
        const removed = cleanNumberedGsdVariants(basePath);
        for (const name of removed) {
          fixesApplied.push(`removed numbered .gsd variant: ${name}`);
        }
      }
    }
  } catch {
    // Non-fatal — variant check failed
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

  // ── Metrics ledger bloat ──────────────────────────────────────────────
  // The metrics ledger has no TTL and grows by one entry per completed unit.
  // At 50 units/day a project can accumulate tens of thousands of entries over
  // months of use. Prune to the newest 1500 when the threshold is exceeded.
  try {
    const metricsFilePath = join(root, "metrics.json");
    if (existsSync(metricsFilePath)) {
      try {
        const raw = readFileSync(metricsFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        const BLOAT_UNITS_THRESHOLD = 2000;
        if (parsed.version === 1 && Array.isArray(parsed.units) && parsed.units.length > BLOAT_UNITS_THRESHOLD) {
          const fileSizeMB = (statSync(metricsFilePath).size / (1024 * 1024)).toFixed(1);
          issues.push({
            severity: "warning",
            code: "metrics_ledger_bloat",
            scope: "project",
            unitId: "project",
            message: `metrics.json has ${parsed.units.length} unit entries (${fileSizeMB}MB) — threshold is ${BLOAT_UNITS_THRESHOLD}. Run /gsd doctor --fix to prune to the newest 1500 entries.`,
            file: ".gsd/metrics.json",
            fixable: true,
          });
          if (shouldFix("metrics_ledger_bloat")) {
            const { pruneMetricsLedger } = await import("./metrics.js");
            const removed = pruneMetricsLedger(basePath, 1500);
            fixesApplied.push(`pruned metrics ledger: removed ${removed} oldest entries (${parsed.units.length - removed} remain)`);
          }
        }
      } catch {
        // JSON parse failed — already handled by the integrity check above
      }
    }
  } catch {
    // Non-fatal — metrics bloat check failed
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

  // ── Snapshot ref bloat ────────────────────────────────────────────────
  // refs/gsd/snapshots/ accumulate over time. Prune to newest 5 per label
  // when total count exceeds threshold.
  try {
    if (nativeIsRepo(basePath)) {
      const refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
      if (refs.length > 50) {
        issues.push({
          severity: "warning",
          code: "snapshot_ref_bloat",
          scope: "project",
          unitId: "project",
          message: `${refs.length} snapshot refs found under refs/gsd/snapshots/ — pruning to newest 5 per label will reclaim git storage`,
          fixable: true,
        });

        if (shouldFix("snapshot_ref_bloat")) {
          const byLabel = new Map<string, string[]>();
          for (const ref of refs) {
            const parts = ref.split("/");
            const label = parts.slice(0, -1).join("/");
            if (!byLabel.has(label)) byLabel.set(label, []);
            byLabel.get(label)!.push(ref);
          }
          let pruned = 0;
          for (const [, labelRefs] of byLabel) {
            const sorted = labelRefs.sort();
            for (const old of sorted.slice(0, -5)) {
              try {
                nativeUpdateRef(basePath, old);
                pruned++;
              } catch { /* skip */ }
            }
          }
          if (pruned > 0) {
            fixesApplied.push(`pruned ${pruned} old snapshot ref(s)`);
          }
        }
      }
    }
  } catch {
    // Non-fatal — snapshot ref check failed
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
