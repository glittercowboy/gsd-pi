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
import { atomicWriteSync } from "./atomic-write.js";
import { clearUnitRuntimeRecord } from "./unit-runtime.js";
import { clearParseCache, parseRoadmap, parsePlan } from "./files.js";
import { isValidationTerminal } from "./state.js";
import {
  nativeConflictFiles,
  nativeCommit,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeMergeAbort,
  nativeResetHard,
} from "./native-git-bridge.js";
import {
  resolveMilestonePath,
  resolveSlicePath,
  resolveSliceFile,
  resolveTasksDir,
  resolveTaskFiles,
  relMilestoneFile,
  relSliceFile,
  relSlicePath,
  relTaskFile,
  buildMilestoneFileName,
  buildSliceFileName,
  buildTaskFileName,
  resolveMilestoneFile,
  clearPathCache,
  resolveGsdRootFile,
} from "./paths.js";
import { markSliceDoneInRoadmap } from "./roadmap-mutations.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ─── Artifact Resolution & Verification ───────────────────────────────────────

/**
 * Resolve the expected artifact for a unit to an absolute path.
 */
export function resolveExpectedArtifactPath(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const parts = unitId.split("/");
  const mid = parts[0]!;
  const sid = parts[1];
  switch (unitType) {
    case "research-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "RESEARCH")) : null;
    }
    case "plan-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "ROADMAP")) : null;
    }
    case "research-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "RESEARCH")) : null;
    }
    case "plan-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "PLAN")) : null;
    }
    case "reassess-roadmap": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "ASSESSMENT")) : null;
    }
    case "run-uat": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "UAT-RESULT")) : null;
    }
    case "execute-task": {
      const tid = parts[2];
      const dir = resolveSlicePath(base, mid, sid!);
      return dir && tid
        ? join(dir, "tasks", buildTaskFileName(tid, "SUMMARY"))
        : null;
    }
    case "complete-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "SUMMARY")) : null;
    }
    case "validate-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "VALIDATION")) : null;
    }
    case "complete-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "SUMMARY")) : null;
    }
    case "replan-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "REPLAN")) : null;
    }
    case "rewrite-docs":
      return null;
    case "reactive-execute":
      // Reactive execute produces multiple task summaries — verified separately
      return null;
    default:
      return null;
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
    const parts = unitId.split("/");
    const mid = parts[0];
    const sidAndBatch = parts[1];
    const batchPart = parts[2]; // "reactive+T02,T03"
    if (!mid || !sidAndBatch || !batchPart) return false;

    const sid = sidAndBatch;
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

  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  // For unit types with no verifiable artifact (null path), the parent directory
  // is missing on disk — treat as stale completion state so the key gets evicted (#313).
  if (!absPath) return false;
  if (!existsSync(absPath)) return false;

  if (unitType === "validate-milestone") {
    const validationContent = readFileSync(absPath, "utf-8");
    if (!isValidationTerminal(validationContent)) return false;
  }

  // plan-slice must produce a plan with actual task entries, not just a scaffold.
  // The plan file may exist from a prior discussion/context step with only headings
  // but no tasks. Without this check the artifact is considered "complete" and the
  // unit gets skipped — but deriveState still returns phase:"planning" because the
  // plan has no tasks, creating an infinite skip loop (#699).
  if (unitType === "plan-slice") {
    const planContent = readFileSync(absPath, "utf-8");
    if (!/^- \[[xX ]\] \*\*T\d+:/m.test(planContent)) return false;
  }

  // execute-task must also have its checkbox marked [x] in the slice plan
  if (unitType === "execute-task") {
    const parts = unitId.split("/");
    const mid = parts[0];
    const sid = parts[1];
    const tid = parts[2];
    if (mid && sid && tid) {
      const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
      if (planAbs && existsSync(planAbs)) {
        const planContent = readFileSync(planAbs, "utf-8");
        const escapedTid = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`^- \\[[xX]\\] \\*\\*${escapedTid}:`, "m");
        if (!re.test(planContent)) return false;
      }
    }
  }

  // plan-slice must also produce individual task plan files for every task listed
  // in the slice plan. Without this check, a plan-slice that wrote S{sid}-PLAN.md
  // but omitted T{tid}-PLAN.md files would be marked complete, causing execute-task
  // to dispatch with a missing task plan (see issue #739).
  if (unitType === "plan-slice") {
    const parts = unitId.split("/");
    const mid = parts[0];
    const sid = parts[1];
    if (mid && sid) {
      try {
        const planContent = readFileSync(absPath, "utf-8");
        const plan = parsePlan(planContent);
        const tasksDir = resolveTasksDir(base, mid, sid);
        if (plan.tasks.length > 0 && tasksDir) {
          for (const task of plan.tasks) {
            const taskPlanFile = join(tasksDir, `${task.id}-PLAN.md`);
            if (!existsSync(taskPlanFile)) return false;
          }
        }
      } catch {
        // Parse failure — don't block; slice plan may have non-standard format
      }
    }
  }

  // complete-slice must also produce a UAT file AND mark the slice [x] in the roadmap.
  // Without the roadmap check, a crash after writing SUMMARY+UAT but before updating
  // the roadmap causes an infinite skip loop: the idempotency key says "done" but the
  // state machine keeps returning the same complete-slice unit (roadmap still shows
  // the slice incomplete), so dispatchNextUnit recurses forever.
  if (unitType === "complete-slice") {
    const parts = unitId.split("/");
    const mid = parts[0];
    const sid = parts[1];
    if (mid && sid) {
      const dir = resolveSlicePath(base, mid, sid);
      if (dir) {
        const uatPath = join(dir, buildSliceFileName(sid, "UAT"));
        if (!existsSync(uatPath)) return false;
      }
      // Verify the roadmap has the slice marked [x]. If not, the completion
      // record is stale — the unit must re-run to update the roadmap.
      const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
      if (roadmapFile && existsSync(roadmapFile)) {
        try {
          const roadmapContent = readFileSync(roadmapFile, "utf-8");
          const roadmap = parseRoadmap(roadmapContent);
          const slice = roadmap.slices.find((s) => s.id === sid);
          if (slice && !slice.done) return false;
        } catch {
          // Corrupt/unparseable roadmap — fail verification so the unit
          // re-runs and has a chance to fix the roadmap. Silently passing
          // here could advance past an incomplete slice.
          return false;
        }
      }
    }
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
  return diagnoseExpectedArtifact(unitType, unitId, base);
}

export function diagnoseExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  switch (unitType) {
    case "research-milestone":
      return `${relMilestoneFile(base, mid!, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      return `${relMilestoneFile(base, mid!, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      return `${relSliceFile(base, mid!, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      return `${relSliceFile(base, mid!, sid!, "PLAN")} (slice plan)`;
    case "execute-task": {
      const tid = parts[2];
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid!, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid!, "ROADMAP")} + summary + UAT written`;
    case "replan-slice":
      return `${relSliceFile(base, mid!, sid!, "REPLAN")} + updated ${relSliceFile(base, mid!, sid!, "PLAN")}`;
    case "rewrite-docs":
      return "Active overrides resolved in .gsd/OVERRIDES.md + plan documents updated";
    case "reassess-roadmap":
      return `${relSliceFile(base, mid!, sid!, "ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      return `${relSliceFile(base, mid!, sid!, "UAT-RESULT")} (UAT result)`;
    case "validate-milestone":
      return `${relMilestoneFile(base, mid!, "VALIDATION")} (milestone validation report)`;
    case "complete-milestone":
      return `${relMilestoneFile(base, mid!, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}

// ─── Skip / Blocker Artifact Generation ───────────────────────────────────────

/**
 * Write skip artifacts for a stuck execute-task: a blocker task summary and
 * the [x] checkbox in the slice plan. Returns true if artifacts were written.
 */
export function skipExecuteTask(
  base: string,
  mid: string,
  sid: string,
  tid: string,
  status: { summaryExists: boolean; taskChecked: boolean },
  reason: string,
  maxAttempts: number,
): boolean {
  // Write a blocker task summary if missing.
  if (!status.summaryExists) {
    const tasksDir = resolveTasksDir(base, mid, sid);
    const sDir = resolveSlicePath(base, mid, sid);
    const targetDir = tasksDir ?? (sDir ? join(sDir, "tasks") : null);
    if (!targetDir) return false;
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const summaryPath = join(targetDir, buildTaskFileName(tid, "SUMMARY"));
    const content = [
      `# BLOCKER — task skipped by auto-mode recovery`,
      ``,
      `Task \`${tid}\` in slice \`${sid}\` (milestone \`${mid}\`) failed to complete after ${reason} recovery exhausted ${maxAttempts} attempts.`,
      ``,
      `This placeholder was written by auto-mode so the pipeline can advance.`,
      `Review this task manually and replace this file with a real summary.`,
    ].join("\n");
    writeFileSync(summaryPath, content, "utf-8");
  }

  // Mark [x] in the slice plan if not already checked.
  if (!status.taskChecked) {
    const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
    if (planAbs && existsSync(planAbs)) {
      const planContent = readFileSync(planAbs, "utf-8");
      const escapedTid = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^(- \\[) \\] (\\*\\*${escapedTid}:)`, "m");
      if (re.test(planContent)) {
        writeFileSync(planAbs, planContent.replace(re, "$1x] $2"), "utf-8");
      } else {
        // Regex didn't match — checkbox format differs from expected pattern.
        // Return false so callers know the plan was NOT updated and can
        // fall through to other recovery strategies instead of assuming success.
        return false;
      }
    }
  }

  return true;
}

// ─── Merge State Reconciliation ───────────────────────────────────────────────

/**
 * Detect leftover merge state from a prior session and reconcile it.
 * If MERGE_HEAD or SQUASH_MSG exists, check whether conflicts are resolved.
 * If resolved: finalize the commit. If still conflicted: abort and reset.
 *
 * Returns true if state was dirty and re-derivation is needed.
 */
export function reconcileMergeState(
  basePath: string,
  ctx: ExtensionContext,
): boolean {
  const mergeHeadPath = join(basePath, ".git", "MERGE_HEAD");
  const squashMsgPath = join(basePath, ".git", "SQUASH_MSG");
  const hasMergeHead = existsSync(mergeHeadPath);
  const hasSquashMsg = existsSync(squashMsgPath);
  if (!hasMergeHead && !hasSquashMsg) return false;

  const conflictedFiles = nativeConflictFiles(basePath);
  if (conflictedFiles.length === 0) {
    // All conflicts resolved — finalize the merge/squash commit
    try {
      nativeCommit(basePath, ""); // --no-edit equivalent: use empty message placeholder
      const mode = hasMergeHead ? "merge" : "squash commit";
      ctx.ui.notify(`Finalized leftover ${mode} from prior session.`, "info");
    } catch {
      // Commit may already exist; non-fatal
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
      } catch {
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
        } catch {
          resolved = false;
        }
      }
      if (!resolved) {
        if (hasMergeHead) {
          try {
            nativeMergeAbort(basePath);
          } catch {
            /* best-effort */
          }
        } else if (hasSquashMsg) {
          try {
            unlinkSync(squashMsgPath);
          } catch {
            /* best-effort */
          }
        }
        try {
          nativeResetHard(basePath);
        } catch {
          /* best-effort */
        }
        ctx.ui.notify(
          "Detected leftover merge state — auto-resolve failed, cleaned up. Re-deriving state.",
          "warning",
        );
      }
    } else {
      // Code conflicts present — abort and reset
      if (hasMergeHead) {
        try {
          nativeMergeAbort(basePath);
        } catch {
          /* best-effort */
        }
      } else if (hasSquashMsg) {
        try {
          unlinkSync(squashMsgPath);
        } catch {
          /* best-effort */
        }
      }
      try {
        nativeResetHard(basePath);
      } catch {
        /* best-effort */
      }
      ctx.ui.notify(
        "Detected leftover merge state with unresolved conflicts — cleaned up. Re-deriving state.",
        "warning",
      );
    }
  }
  return true;
}

// ─── Self-Heal Runtime Records ────────────────────────────────────────────────

/**
 * Self-heal: scan runtime records in .gsd/ and clear stale ones.
 * Clears dispatched records older than 1 hour (process crashed before
 * completing the unit). deriveState() handles re-derivation — no need
 * for completion key persistence here.
 */
export async function selfHealRuntimeRecords(
  base: string,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    const { listUnitRuntimeRecords } = await import("./unit-runtime.js");
    const records = listUnitRuntimeRecords(base);
    let healed = 0;
    const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    for (const record of records) {
      const { unitType, unitId } = record;

      // Case 0: complete-slice with SUMMARY + UAT but unchecked roadmap (#1350).
      // If a complete-slice was interrupted after writing artifacts but before
      // flipping the roadmap checkbox, the verification fails and the dispatch
      // loop relaunches the same unit forever. Auto-fix the checkbox.
      if (unitType === "complete-slice") {
        const { milestone: mid, slice: sid } = parseUnitId(unitId);
        if (mid && sid) {
          const dir = resolveSlicePath(base, mid, sid);
          if (dir) {
            const summaryPath = join(dir, buildSliceFileName(sid, "SUMMARY"));
            const uatPath = join(dir, buildSliceFileName(sid, "UAT"));
            if (existsSync(summaryPath) && existsSync(uatPath)) {
              const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
              if (roadmapFile && existsSync(roadmapFile)) {
                try {
                  const roadmapContent = readFileSync(roadmapFile, "utf-8");
                  const roadmap = parseRoadmap(roadmapContent);
                  const slice = (roadmap.slices ?? []).find(s => s.id === sid);
                  if (slice && !slice.done) {
                    // Auto-fix: flip the checkbox using shared utility
                    if (markSliceDoneInRoadmap(base, mid, sid)) {
                      ctx.ui.notify(
                        `Self-heal: marked ${sid} done in roadmap (SUMMARY + UAT exist but checkbox was stale).`,
                        "info",
                      );
                    }
                  }
                } catch {
                  // Roadmap parse failure — don't block self-heal
                }
              }
            }
          }
        }
      }

      // Clear stale dispatched records (dispatched > 1h ago, process crashed)
      const age = now - (record.startedAt ?? 0);
      if (record.phase === "dispatched" && age > STALE_THRESHOLD_MS) {
        clearUnitRuntimeRecord(base, unitType, unitId);
        healed++;
        continue;
      }
    }
    if (healed > 0) {
      ctx.ui.notify(
        `Self-heal: cleared ${healed} stale runtime record(s).`,
        "info",
      );
    }
  } catch (e) {
    // Non-fatal — self-heal should never block auto-mode start
    void e;
  }
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
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  const tid = parts[2];
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      const planRel = relSliceFile(base, mid, sid, "PLAN");
      const summaryRel = relTaskFile(base, mid, sid, tid, "SUMMARY");
      return [
        `   1. Write ${summaryRel} (even a partial summary is sufficient to unblock the pipeline)`,
        `   2. Mark ${tid} [x] in ${planRel}: change "- [ ] **${tid}:" → "- [x] **${tid}:"`,
        `   3. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   4. Resume auto-mode — it will pick up from the next task`,
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
        `   2. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Write the slice summary and UAT file for ${sid} in ${relSlicePath(base, mid, sid)}`,
        `   2. Mark ${sid} [x] in ${relMilestoneFile(base, mid, "ROADMAP")}`,
        `   3. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   4. Resume auto-mode`,
      ].join("\n");
    }
    case "validate-milestone": {
      if (!mid) break;
      const artifactRel = relMilestoneFile(base, mid, "VALIDATION");
      return [
        `   1. Write ${artifactRel} with verdict: pass`,
        `   2. Run \`gsd doctor\``,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
