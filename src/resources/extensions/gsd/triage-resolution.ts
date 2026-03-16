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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Classification, CaptureEntry } from "./captures.js";
import {
  loadPendingCaptures,
  loadAllCaptures,
  markCaptureResolved,
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
    const planPath = join(basePath, ".gsd", "milestones", mid, "slices", sid, `${sid}-PLAN.md`);
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
    const content = [
      `# Replan Trigger`,
      ``,
      `**Source:** Capture ${capture.id}`,
      `**Capture:** ${capture.text}`,
      `**Rationale:** ${capture.rationale ?? "User-initiated replan via capture triage"}`,
      `**Triggered:** ${new Date().toISOString()}`,
      ``,
      `This file was created by the triage pipeline. The next dispatch cycle`,
      `will detect it and enter the replanning-slice phase.`,
    ].join("\n");

    writeFileSync(triggerPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
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
    `1. Execute this task as a small, self-contained change.`,
    `2. Do NOT modify any \`.gsd/\` plan files — this is a one-off, not a planned task.`,
    `3. Commit your changes with a descriptive message.`,
    `4. Keep changes minimal and focused on the capture text.`,
    `5. When done, say: "Quick task complete."`,
  ].join("\n");
}
