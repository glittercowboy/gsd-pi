/**
 * GSD Triage Resolution — Execute triage classifications
 *
 * Provides resolution executors for each capture classification type:
 *
 * - inject: appends a new task to the current slice plan
 * - replan: writes REPLAN-TRIGGER.md so next dispatchNextUnit enters replanning-slice
 * - defer/note: query helpers for loading deferred/replan captures
 *
 * Also provides detectFileOverlap() for surfacing downstream impact on quick tasks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gsdRoot, milestonesDir } from "./paths.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import type { Classification, CaptureEntry } from "./captures.js";
import {
  loadPendingCaptures,
  loadAllCaptures,
  loadActionableCaptures,
  markCaptureResolved,
  markCaptureExecuted,
  stampCaptureMilestone,
} from "./captures.js";

// ─── Resolution Executors ─────────────────────────────────────────────────────

/**
 * Inject a new task into the current slice plan.
 * Reads the plan, finds the highest task ID, appends a new task entry.
 * Returns the new task ID, or null if injection failed.
 */
export function executeInject(
  basePath: string,
  mid: string,
  sid: string,
  capture: CaptureEntry,
): string | null {
  try {
    // Resolve the plan file path
    const planPath = join(gsdRoot(basePath), "milestones", mid, "slices", sid, `${sid}-PLAN.md`);
    if (!existsSync(planPath)) return null;

    const content = readFileSync(planPath, "utf-8");

    // Find the highest existing task ID
    const taskMatches = [...content.matchAll(/- \[[ x]\] \*\*T(\d+):/g)];
    if (taskMatches.length === 0) return null;

    const maxId = Math.max(...taskMatches.map(m => parseInt(m[1], 10)));
    const newId = `T${String(maxId + 1).padStart(2, "0")}`;

    // Build the new task entry
    const newTask = [
      `- [ ] **${newId}: ${capture.text}** \`est:30m\``,
      `  - Why: Injected from capture ${capture.id} during triage`,
      `  - Do: ${capture.text}`,
      `  - Done when: Capture intent fulfilled`,
    ].join("\n");

    // Find the last task entry and append after it
    // Look for the "## Files Likely Touched" section as the boundary
    const filesSection = content.indexOf("## Files Likely Touched");
    if (filesSection !== -1) {
      const updated = content.slice(0, filesSection) + newTask + "\n\n" + content.slice(filesSection);
      writeFileSync(planPath, updated, "utf-8");
    } else {
      // No Files section — append at end
      writeFileSync(planPath, content.trimEnd() + "\n\n" + newTask + "\n", "utf-8");
    }

    return newId;
  } catch {
    return null;
  }
}

/**
 * Trigger replanning by writing a REPLAN-TRIGGER.md marker file.
 * The existing state.ts derivation detects this and sets phase to "replanning-slice".
 * Returns true if the trigger was written successfully.
 */
export function executeReplan(
  basePath: string,
  mid: string,
  sid: string,
  capture: CaptureEntry,
): boolean {
  try {
    const triggerPath = join(
      basePath, ".gsd", "milestones", mid, "slices", sid, `${sid}-REPLAN-TRIGGER.md`,
    );
    const ts = new Date().toISOString();
    const content = [
      `# Replan Trigger`,
      ``,
      `**Source:** Capture ${capture.id}`,
      `**Capture:** ${capture.text}`,
      `**Rationale:** ${capture.rationale ?? "User-initiated replan via capture triage"}`,
      `**Triggered:** ${ts}`,
      ``,
      `This file was created by the triage pipeline. The next dispatch cycle`,
      `will detect it and enter the replanning-slice phase.`,
    ].join("\n");

    writeFileSync(triggerPath, content, "utf-8");

    // Also write replan_triggered_at column for DB-backed detection
    try {
      const req = createRequire(import.meta.url);
      const { isDbAvailable, _getAdapter } = req("./gsd-db.js");
      if (isDbAvailable()) {
        const adapter = _getAdapter();
        if (adapter) {
          adapter.prepare(
            "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
          ).run({ ":ts": ts, ":mid": mid, ":sid": sid });
        }
      }
    } catch {
      // DB write is best-effort — disk file is the primary trigger for fallback path
    }

    return true;
  } catch {
    return false;
  }
}

// ─── Backtrack (Milestone Regression) ────────────────────────────────────────

/**
 * Execute a backtrack directive — user wants to abandon current milestone
 * and return to a previous one (milestone regression).
 *
 * Writes a BACKTRACK-TRIGGER.md marker at `.gsd/BACKTRACK-TRIGGER.md` with
 * the target milestone, reason, and timestamp. The state machine (deriveState)
 * detects this and transitions the project to the target milestone, resetting
 * its slices to allow re-planning.
 *
 * Returns the extracted target milestone ID, or null if extraction failed.
 */
export function executeBacktrack(
  basePath: string,
  currentMilestoneId: string,
  capture: CaptureEntry,
): string | null {
  try {
    // Extract target milestone from capture text or resolution.
    // Filter out the current milestone ID to avoid picking it as the backtrack target
    // when the text mentions both current and target milestones (e.g. "backtrack from M004 to M003").
    const sourceText = capture.resolution ?? capture.text;
    const allMatches = [...sourceText.matchAll(/\b(M\d{3}(?:-[a-z0-9]{6})?)\b/g)]
      .map(m => m[1])
      .filter(id => id !== currentMilestoneId);
    // Reject ambiguous multi-target strings — if more than one distinct target remains,
    // don't guess; let the user clarify.
    const uniqueTargets = [...new Set(allMatches)];
    const targetMilestoneId = uniqueTargets.length === 1 ? uniqueTargets[0] : null;

    const ts = new Date().toISOString();
    const triggerPath = join(gsdRoot(basePath), "BACKTRACK-TRIGGER.md");
    const content = [
      `# Backtrack Trigger`,
      ``,
      `**Source:** Capture ${capture.id}`,
      `**Capture:** ${capture.text}`,
      `**Rationale:** ${capture.rationale ?? "User-initiated milestone backtrack"}`,
      `**From:** ${currentMilestoneId}`,
      `**Target:** ${targetMilestoneId ?? "(user to specify)"}`,
      `**Triggered:** ${ts}`,
      ``,
      `Auto-mode was paused by this backtrack directive. The user directed`,
      `that the current milestone (${currentMilestoneId}) be abandoned and work`,
      `should return to ${targetMilestoneId ?? "a previous milestone"}.`,
      ``,
      `## Recovery Steps`,
      ``,
      `1. Review what went wrong in ${currentMilestoneId}`,
      `2. Identify missing features/requirements from the target milestone`,
      `3. Resume auto-mode — the state machine will re-enter discussion for the target`,
    ].join("\n");

    writeFileSync(triggerPath, content, "utf-8");

    // If we have a valid target, also reset that milestone's completion status
    // so deriveState() will re-enter it as the active milestone.
    if (targetMilestoneId) {
      try {
        const targetDir = join(milestonesDir(basePath), targetMilestoneId);
        if (existsSync(targetDir)) {
          // Write a regression marker so the state machine knows this milestone
          // needs re-discussion, not just re-execution
          const regressionPath = join(targetDir, `${targetMilestoneId}-REGRESSION.md`);
          writeFileSync(regressionPath, [
            `# Milestone Regression`,
            ``,
            `**From:** ${currentMilestoneId}`,
            `**Reason:** ${capture.text}`,
            `**Triggered:** ${ts}`,
            ``,
            `This milestone is being revisited because downstream milestone`,
            `${currentMilestoneId} failed or missed critical features that should`,
            `have been part of this milestone's scope.`,
            ``,
            `The discuss phase should re-evaluate requirements and identify gaps.`,
          ].join("\n"), "utf-8");
        }
      } catch { /* best-effort */ }
    }

    return targetMilestoneId;
  } catch {
    return null;
  }
}

/**
 * Read the backtrack trigger file if it exists.
 * Returns the parsed target milestone and metadata, or null.
 */
export function readBacktrackTrigger(basePath: string): {
  target: string | null;
  from: string | null;
  capture: string;
  triggeredAt: string;
} | null {
  const triggerPath = join(gsdRoot(basePath), "BACKTRACK-TRIGGER.md");
  if (!existsSync(triggerPath)) return null;

  try {
    const content = readFileSync(triggerPath, "utf-8");
    const target = content.match(/\*\*Target:\*\*\s*(.+)/)?.[1]?.trim() ?? null;
    const from = content.match(/\*\*From:\*\*\s*(.+)/)?.[1]?.trim() ?? null;
    const capture = content.match(/\*\*Capture:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
    const triggeredAt = content.match(/\*\*Triggered:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
    return {
      target: target === "(user to specify)" ? null : target,
      from,
      capture,
      triggeredAt,
    };
  } catch {
    return null;
  }
}

/**
 * Remove the backtrack trigger after it has been processed.
 */
export function clearBacktrackTrigger(basePath: string): void {
  const triggerPath = join(gsdRoot(basePath), "BACKTRACK-TRIGGER.md");
  try {
    if (existsSync(triggerPath)) {
      unlinkSync(triggerPath);
    }
  } catch { /* best-effort */ }
}

// ─── File Overlap Detection ───────────────────────────────────────────────────

/**
 * Detect file overlap between a capture's affected files and planned tasks.
 *
 * Parses the slice plan for task file references and returns task IDs
 * whose files overlap with the capture's affected files.
 *
 * @param affectedFiles - Files the capture would touch
 * @param planContent - Content of the slice plan.md
 * @returns Array of task IDs (e.g., ["T03", "T04"]) whose files overlap
 */
export function detectFileOverlap(
  affectedFiles: string[],
  planContent: string,
): string[] {
  if (!affectedFiles || affectedFiles.length === 0) return [];

  const overlappingTasks: string[] = [];

  // Normalize affected files for comparison
  const normalizedAffected = new Set(
    affectedFiles.map(f => f.replace(/^\.\//, "").toLowerCase()),
  );

  // Parse plan for incomplete tasks and their file references
  const taskPattern = /- \[ \] \*\*(T\d+):[^*]*\*\*/g;
  const tasks = [...planContent.matchAll(taskPattern)];

  for (const taskMatch of tasks) {
    const taskId = taskMatch[1];
    const taskStart = taskMatch.index!;

    // Find the end of this task (next task or end of section)
    const nextTask = planContent.indexOf("- [", taskStart + 1);
    const sectionEnd = planContent.indexOf("##", taskStart + 1);
    const taskEnd = Math.min(
      nextTask === -1 ? planContent.length : nextTask,
      sectionEnd === -1 ? planContent.length : sectionEnd,
    );

    const taskContent = planContent.slice(taskStart, taskEnd);

    // Extract file references — look for backtick-quoted paths
    const fileRefs = [...taskContent.matchAll(/`([^`]+\.[a-z]+)`/g)]
      .map(m => m[1].replace(/^\.\//, "").toLowerCase());

    // Check for overlap
    const hasOverlap = fileRefs.some(f => normalizedAffected.has(f));
    if (hasOverlap) {
      overlappingTasks.push(taskId);
    }
  }

  return overlappingTasks;
}

// ─── Defer Milestone Creation ─────────────────────────────────────────────────

/**
 * Ensure the milestone directory exists when triage defers a capture to a
 * not-yet-created milestone (e.g., "M005").
 *
 * Creates the directory with a seed CONTEXT-DRAFT.md so that `deriveState()`
 * discovers the milestone and enters the discussion phase instead of
 * treating the project as fully complete.
 *
 * @param basePath - Project root
 * @param targetMilestone - The milestone ID to defer to (e.g., "M005")
 * @param captures - Captures being deferred to this milestone
 * @returns true if the directory was created (or already existed), false on error
 */
export function ensureDeferMilestoneDir(
  basePath: string,
  targetMilestone: string,
  captures: CaptureEntry[],
): boolean {
  if (!MILESTONE_ID_RE.test(targetMilestone)) return false;

  const msDir = join(milestonesDir(basePath), targetMilestone);
  if (existsSync(msDir)) return true;

  try {
    mkdirSync(msDir, { recursive: true });

    // Seed CONTEXT-DRAFT.md with deferred capture context
    const captureList = captures
      .map(c => `- **${c.id}:** ${c.text}`)
      .join("\n");

    const draftContent = [
      `# ${targetMilestone}: Deferred Work`,
      ``,
      `This milestone was created by triage when captures were deferred here.`,
      `Discuss scope and goals before planning slices.`,
      ``,
      `## Deferred Captures`,
      ``,
      captureList || `(no captures yet)`,
      ``,
    ].join("\n");

    writeFileSync(
      join(msDir, `${targetMilestone}-CONTEXT-DRAFT.md`),
      draftContent,
      "utf-8",
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Load deferred captures (classification === "defer") for injection into
 * reassess-roadmap prompts.
 */
export function loadDeferredCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(c => c.classification === "defer");
}

/**
 * Load replan-triggering captures for injection into replan-slice prompts.
 */
export function loadReplanCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(c => c.classification === "replan");
}

/**
 * Build a quick-task execution prompt from a capture.
 */
export function buildQuickTaskPrompt(capture: CaptureEntry): string {
  return [
    `You are executing a quick one-off task captured during a GSD auto-mode session.`,
    ``,
    `## Quick Task`,
    ``,
    `**Capture ID:** ${capture.id}`,
    `**Task:** ${capture.text}`,
    ``,
    `## Instructions`,
    ``,
    `1. **Verify the issue still exists.** Before making any changes, inspect the`,
    `   relevant code to confirm the problem described above is actually present in`,
    `   the current codebase. If the issue has already been fixed (e.g., by planned`,
    `   milestone work), report "Already resolved — no changes needed." and stop.`,
    `2. Execute this task as a small, self-contained change.`,
    `3. Do NOT modify any \`.gsd/\` plan files — this is a one-off, not a planned task.`,
    `4. Commit your changes with a descriptive message.`,
    `5. Keep changes minimal and focused on the capture text.`,
    `6. When done, say: "Quick task complete."`,
  ].join("\n");
}

// ─── Post-Triage Resolution Executor ─────────────────────────────────────────

/**
 * Result of executing triage resolutions after a triage-captures unit completes.
 */
export interface TriageExecutionResult {
  /** Number of inject resolutions executed (tasks added to plan) */
  injected: number;
  /** Number of replan triggers written */
  replanned: number;
  /** Number of defer milestone directories created */
  deferredMilestones: number;
  /** Captures classified as quick-task that need dispatch */
  quickTasks: CaptureEntry[];
  /** Number of stop directives (will pause auto-mode via guard) */
  stopped: number;
  /** Backtrack captures (will trigger milestone regression via guard) */
  backtracks: CaptureEntry[];
  /** Details of each action taken, for logging */
  actions: string[];
}

/**
 * Execute pending triage resolutions.
 *
 * Called after a triage-captures unit completes. Reads CAPTURES.md for
 * resolved captures that have actionable classifications (inject, replan,
 * quick-task) but haven't been executed yet, then:
 *
 * - inject: calls executeInject() to add a task to the current slice plan
 * - replan: calls executeReplan() to write the REPLAN-TRIGGER.md marker
 * - quick-task: collects for dispatch (caller handles dispatching quick-task units)
 *
 * Each capture is marked as executed after its resolution action succeeds,
 * preventing double-execution on retries or restarts.
 */
export function executeTriageResolutions(
  basePath: string,
  mid: string,
  sid: string,
): TriageExecutionResult {
  const result: TriageExecutionResult = {
    injected: 0,
    replanned: 0,
    deferredMilestones: 0,
    quickTasks: [],
    stopped: 0,
    backtracks: [],
    actions: [],
  };

  const actionable = loadActionableCaptures(basePath, mid || undefined);

  // Reconciliation: stamp actionable captures that are missing the Milestone field
  // with the current milestone ID.  This covers captures resolved by the triage LLM
  // before the prompt included the Milestone instruction, and acts as a safety net
  // when the LLM omits the field (#2872).
  if (mid) {
    for (const capture of actionable) {
      if (!capture.resolvedInMilestone) {
        stampCaptureMilestone(basePath, capture.id, mid);
      }
    }
  }

  // Also process deferred captures that target milestone IDs — create
  // milestone directories so deriveState() discovers them.
  const deferred = loadAllCaptures(basePath).filter(
    c => c.status === "resolved" && !c.executed && c.classification === "defer",
  );
  if (deferred.length > 0) {
    // Group deferred captures by target milestone
    const byMilestone = new Map<string, CaptureEntry[]>();
    for (const cap of deferred) {
      const target = cap.resolution?.match(/\b(M\d{3}(?:-[a-z0-9]{6})?)\b/)?.[1];
      if (target) {
        const list = byMilestone.get(target) ?? [];
        list.push(cap);
        byMilestone.set(target, list);
      }
    }
    for (const [milestoneId, captures] of byMilestone) {
      const msDir = join(milestonesDir(basePath), milestoneId);
      if (!existsSync(msDir)) {
        const created = ensureDeferMilestoneDir(basePath, milestoneId, captures);
        if (created) {
          result.deferredMilestones++;
          result.actions.push(`Created milestone ${milestoneId} for ${captures.length} deferred capture(s)`);
          for (const cap of captures) {
            markCaptureExecuted(basePath, cap.id);
          }
        }
      }
    }
  }

  if (actionable.length === 0) return result;

  for (const capture of actionable) {
    switch (capture.classification) {
      case "inject": {
        const newTaskId = executeInject(basePath, mid, sid, capture);
        if (newTaskId) {
          markCaptureExecuted(basePath, capture.id);
          result.injected++;
          result.actions.push(`Injected ${newTaskId} from ${capture.id}: "${capture.text}"`);
        } else {
          result.actions.push(`Failed to inject ${capture.id}: "${capture.text}" (no plan file or parse error)`);
        }
        break;
      }
      case "replan": {
        const success = executeReplan(basePath, mid, sid, capture);
        if (success) {
          markCaptureExecuted(basePath, capture.id);
          result.replanned++;
          result.actions.push(`Replan triggered from ${capture.id}: "${capture.text}"`);
        } else {
          result.actions.push(`Failed to trigger replan from ${capture.id}: "${capture.text}"`);
        }
        break;
      }
      case "quick-task": {
        // Quick-tasks are collected for dispatch, not executed inline
        result.quickTasks.push(capture);
        result.actions.push(`Quick-task queued from ${capture.id}: "${capture.text}"`);
        break;
      }
    }
  }

  // Count stop/backtrack captures — these are handled by the pre-dispatch guard
  // in runGuards(), not here. We just report them for logging purposes.
  const allCaptures = loadAllCaptures(basePath);
  for (const cap of allCaptures) {
    if (cap.status !== "resolved" || cap.executed) continue;
    if (cap.classification === "stop") {
      result.stopped++;
      result.actions.push(`Stop directive from ${cap.id}: "${cap.text}" — will pause on next dispatch`);
    } else if (cap.classification === "backtrack") {
      result.backtracks.push(cap);
      result.actions.push(`Backtrack directive from ${cap.id}: "${cap.text}" — will trigger milestone regression on next dispatch`);
    }
  }

  return result;
}
