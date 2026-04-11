// GSD Markdown Renderer — DB → Markdown file generation
//
// Transforms DB state into correct markdown files on disk.
// Each render function reads from DB (with disk fallback),
// patches content to match DB status, writes atomically to disk,
// stores updated content in the artifacts table, and invalidates caches.
//
// Critical invariant: rendered markdown must round-trip through
// parseRoadmap(), parsePlan(), parseSummary() in files.ts.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { logWarning } from "./workflow-logger.js";
import { isClosedStatus } from "./status-guards.js";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import {
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getTask,
  getSlice,
  getArtifact,
  insertArtifact,
  getGateResults,
} from "./gsd-db.js";
import type { MilestoneRow, SliceRow, TaskRow, ArtifactRow } from "./gsd-db.js";
import type { GateRow } from "./types.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTasksDir,
  gsdRoot,
  buildTaskFileName,
  buildSliceFileName,
} from "./paths.js";
import { saveFile, clearParseCache } from "./files.js";
import { invalidateStateCache } from "./state.js";
import { clearPathCache } from "./paths.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert an absolute file path to a .gsd-relative artifact path.
 * E.g. "/project/.gsd/milestones/M001/M001-ROADMAP.md" → "milestones/M001/M001-ROADMAP.md"
 */
function toArtifactPath(absPath: string, basePath: string): string {
  const root = gsdRoot(basePath);
  const rel = relative(root, absPath);
  // Normalize to forward slashes for consistent DB keys
  return rel.replace(/\\/g, "/");
}

/**
 * Invalidate all caches after a disk write.
 */
function invalidateCaches(): void {
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
}

/**
 * Load artifact content from DB first, falling back to reading from disk.
 * On disk fallback, stores the content in the artifacts table for future use.
 * Returns null if content is unavailable from both sources.
 */
function loadArtifactContent(
  artifactPath: string,
  absPath: string | null,
  opts: {
    artifact_type: string;
    milestone_id: string;
    slice_id?: string;
    task_id?: string;
  },
): string | null {
  // Try DB first
  const artifact = getArtifact(artifactPath);
  if (artifact && artifact.full_content) {
    return artifact.full_content;
  }

  // Fall back to disk
  if (!absPath) {
    process.stderr.write(
      `markdown-renderer: artifact not found in DB or on disk: ${artifactPath}\n`,
    );
    return null;
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    logWarning("renderer", `cannot read file from disk: ${absPath}`);
    return null;
  }

  // Store in DB for future use (graceful degradation path)
  try {
    insertArtifact({
      path: artifactPath,
      artifact_type: opts.artifact_type,
      milestone_id: opts.milestone_id,
      slice_id: opts.slice_id ?? null,
      task_id: opts.task_id ?? null,
      full_content: content,
    });
  } catch {
    // Non-fatal: we have the content, DB storage is best-effort
    logWarning("renderer", `failed to store disk fallback in DB: ${artifactPath}`);
  }

  return content;
}

/**
 * Write rendered content to disk and update the artifacts table.
 */
async function writeAndStore(
  absPath: string,
  artifactPath: string,
  content: string,
  opts: {
    artifact_type: string;
    milestone_id: string;
    slice_id?: string;
    task_id?: string;
  },
): Promise<void> {
  await saveFile(absPath, content);

  try {
    insertArtifact({
      path: artifactPath,
      artifact_type: opts.artifact_type,
      milestone_id: opts.milestone_id,
      slice_id: opts.slice_id ?? null,
      task_id: opts.task_id ?? null,
      full_content: content,
    });
  } catch {
    // Non-fatal: file is on disk, DB is best-effort
    logWarning("renderer", `failed to update artifact in DB: ${artifactPath}`);
  }

  invalidateCaches();
}

function renderRoadmapMarkdown(milestone: MilestoneRow, slices: SliceRow[]): string {
  const lines: string[] = [];

  lines.push(`# ${milestone.id}: ${milestone.title || milestone.id}`);
  lines.push("");
  lines.push(`**Vision:** ${milestone.vision}`);
  lines.push("");

  if (milestone.success_criteria.length > 0) {
    lines.push("## Success Criteria");
    lines.push("");
    for (const criterion of milestone.success_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push("");
  }

  lines.push("## Slices");
  lines.push("");
  for (const slice of slices) {
    const done = slice.status === "complete" ? "x" : " ";
    const depends = `[${(slice.depends ?? []).join(",")}]`;
    lines.push(`- [${done}] **${slice.id}: ${slice.title}** \`risk:${slice.risk}\` \`depends:${depends}\``);
    lines.push(`  > After this: ${slice.demo}`);
    lines.push("");
  }

  if (milestone.boundary_map_markdown.trim()) {
    lines.push("## Boundary Map");
    lines.push("");
    lines.push(milestone.boundary_map_markdown.trim());
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaskPlanMarkdown(task: TaskRow, taskGates: GateRow[] = []): string {
  const estimatedSteps = Math.max(1, task.description.trim().split(/\n+/).filter(Boolean).length || 1);
  const estimatedFiles = task.files.length > 0
    ? task.files.length
    : task.expected_output.length > 0
      ? task.expected_output.length
      : task.inputs.length > 0
        ? task.inputs.length
        : 1;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`estimated_steps: ${estimatedSteps}`);
  lines.push(`estimated_files: ${estimatedFiles}`);
  lines.push("skills_used: []");
  lines.push("---");
  lines.push("");
  lines.push(`# ${task.id}: ${task.title || task.id}`);
  lines.push("");

  if (task.description.trim()) {
    lines.push(task.description.trim());
    lines.push("");
  }

  lines.push("## Inputs");
  lines.push("");
  if (task.inputs.length > 0) {
    for (const input of task.inputs) {
      lines.push(`- \`${input}\``);
    }
  } else {
    lines.push("- None specified.");
  }
  lines.push("");

  lines.push("## Expected Output");
  lines.push("");
  if (task.expected_output.length > 0) {
    for (const output of task.expected_output) {
      lines.push(`- \`${output}\``);
    }
  } else if (task.files.length > 0) {
    for (const file of task.files) {
      lines.push(`- \`${file}\``);
    }
  } else {
    lines.push("- Update the implementation and proof artifacts needed for this task.");
  }
  lines.push("");

  lines.push("## Verification");
  lines.push("");
  lines.push(task.verify.trim() || "- Verify the task outcome with the slice-level checks.");
  lines.push("");

  if (task.observability_impact.trim()) {
    lines.push("## Observability Impact");
    lines.push("");
    lines.push(task.observability_impact.trim());
    lines.push("");
  }

  // ── Quality Gate Sections (Q5/Q6/Q7) ──────────────────────────────────
  const gateLabels: Record<string, string> = { Q5: "Failure Modes", Q6: "Load Profile", Q7: "Negative Tests" };
  for (const [gid, label] of Object.entries(gateLabels)) {
    const gate = taskGates.find(g => g.gate_id === gid && g.status === "complete");
    if (gate && gate.verdict !== "omitted") {
      lines.push(`## ${label}`);
      lines.push("");
      lines.push(gate.findings.trim() || `- **Verdict:** ${gate.verdict}\n- **Rationale:** ${gate.rationale}`);
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSlicePlanMarkdown(slice: SliceRow, tasks: TaskRow[], gates: GateRow[] = []): string {
  const lines: string[] = [];

  lines.push(`# ${slice.id}: ${slice.title || slice.id}`);
  lines.push("");
  lines.push(`**Goal:** ${slice.goal}`);
  lines.push(`**Demo:** ${slice.demo}`);
  lines.push("");

  lines.push("## Must-Haves");
  lines.push("");
  if (slice.success_criteria.trim()) {
    for (const line of slice.success_criteria.split(/\n+/).map((entry) => entry.trim()).filter(Boolean)) {
      lines.push(line.startsWith("-") ? line : `- ${line}`);
    }
  } else {
    lines.push("- Complete the planned slice outcomes.");
  }
  lines.push("");

  // ── Quality Gate Sections (Q3/Q4) ────────────────────────────────────
  const q3 = gates.find(g => g.gate_id === "Q3" && g.status === "complete");
  if (q3 && q3.verdict !== "omitted") {
    lines.push("## Threat Surface");
    lines.push("");
    lines.push(q3.findings.trim() || `- **Verdict:** ${q3.verdict}\n- **Rationale:** ${q3.rationale}`);
    lines.push("");
  }

  const q4 = gates.find(g => g.gate_id === "Q4" && g.status === "complete");
  if (q4 && q4.verdict !== "omitted") {
    lines.push("## Requirement Impact");
    lines.push("");
    lines.push(q4.findings.trim() || `- **Verdict:** ${q4.verdict}\n- **Rationale:** ${q4.rationale}`);
    lines.push("");
  }

  if (slice.proof_level.trim()) {
    lines.push("## Proof Level");
    lines.push("");
    lines.push(`- This slice proves: ${slice.proof_level.trim()}`);
    lines.push("");
  }

  if (slice.integration_closure.trim()) {
    lines.push("## Integration Closure");
    lines.push("");
    lines.push(slice.integration_closure.trim());
    lines.push("");
  }

  lines.push("## Verification");
  lines.push("");
  if (slice.observability_impact.trim()) {
    const verificationLines = slice.observability_impact
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const line of verificationLines) {
      lines.push(line.startsWith("-") ? line : `- ${line}`);
    }
  } else {
    lines.push("- Run the task and slice verification checks for this slice.");
  }
  lines.push("");

  lines.push("## Tasks");
  lines.push("");
  for (const task of tasks) {
    const done = isClosedStatus(task.status) ? "x" : " ";
    const estimate = task.estimate.trim() ? ` \`est:${task.estimate.trim()}\`` : "";
    lines.push(`- [${done}] **${task.id}: ${task.title || task.id}**${estimate}`);
    if (task.description.trim()) {
      lines.push(`  ${task.description.trim()}`);
    }
    if (task.files.length > 0) {
      lines.push(`  - Files: ${task.files.map((file) => `\`${file}\``).join(", ")}`);
    }
    if (task.verify.trim()) {
      lines.push(`  - Verify: ${task.verify.trim()}`);
    }
    lines.push("");
  }

  const filesLikelyTouched = Array.from(new Set(tasks.flatMap((task) => task.files)));
  if (filesLikelyTouched.length > 0) {
    lines.push("## Files Likely Touched");
    lines.push("");
    for (const file of filesLikelyTouched) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function renderPlanFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<{ planPath: string; taskPlanPaths: string[]; content: string }> {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice) {
    throw new Error(`slice ${milestoneId}/${sliceId} not found`);
  }

  const tasks = getSliceTasks(milestoneId, sliceId);
  if (tasks.length === 0) {
    throw new Error(`no tasks found for ${milestoneId}/${sliceId}`);
  }

  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId)
    ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
  const absPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN")
    ?? join(slicePath, `${sliceId}-PLAN.md`);
  const artifactPath = toArtifactPath(absPath, basePath);
  const sliceGates = getGateResults(milestoneId, sliceId, "slice");
  const content = renderSlicePlanMarkdown(slice, tasks, sliceGates);

  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
  });

  const taskPlanPaths: string[] = [];
  for (const task of tasks) {
    const rendered = await renderTaskPlanFromDb(basePath, milestoneId, sliceId, task.id);
    taskPlanPaths.push(rendered.taskPlanPath);
  }

  return { planPath: absPath, taskPlanPaths, content };
}

export async function renderTaskPlanFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<{ taskPlanPath: string; content: string }> {
  const task = getTask(milestoneId, sliceId, taskId);
  if (!task) {
    throw new Error(`task ${milestoneId}/${sliceId}/${taskId} not found`);
  }

  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId)
    ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const absPath = join(tasksDir, buildTaskFileName(taskId, "PLAN"));
  const artifactPath = toArtifactPath(absPath, basePath);
  const taskGates = getGateResults(milestoneId, sliceId, "task").filter(g => g.task_id === taskId);
  const content = task.full_plan_md.trim() ? task.full_plan_md : renderTaskPlanMarkdown(task, taskGates);

  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: taskId,
  });

  return { taskPlanPath: absPath, content };
}

export async function renderRoadmapFromDb(
  basePath: string,
  milestoneId: string,
): Promise<{ roadmapPath: string; content: string }> {
  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    throw new Error(`milestone ${milestoneId} not found`);
  }

  const slices = getMilestoneSlices(milestoneId);
  const absPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP") ??
    join(gsdRoot(basePath), "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);
  const artifactPath = toArtifactPath(absPath, basePath);
  const content = renderRoadmapMarkdown(milestone, slices);

  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ROADMAP",
    milestone_id: milestoneId,
  });

  return { roadmapPath: absPath, content };
}

// ─── Roadmap Checkbox Rendering ───────────────────────────────────────────

/**
 * Render roadmap checkbox states from DB.
 *
 * For each slice in the milestone, sets [x] if status === 'complete',
 * [ ] otherwise. Handles bidirectional updates (can uncheck previously
 * checked slices if DB says pending).
 *
 * @returns true if the roadmap was written, false on skip/error
 */
export async function renderRoadmapCheckboxes(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) {
    process.stderr.write(
      `markdown-renderer: no slices found for milestone ${milestoneId}\n`,
    );
    return false;
  }

  const absPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  const artifactPath = absPath ? toArtifactPath(absPath, basePath) : null;

  // Load content from DB (with disk fallback)
  let content: string | null = null;
  if (artifactPath) {
    content = loadArtifactContent(artifactPath, absPath, {
      artifact_type: "ROADMAP",
      milestone_id: milestoneId,
    });
  }

  if (!content) {
    process.stderr.write(
      `markdown-renderer: no roadmap content available for ${milestoneId}\n`,
    );
    return false;
  }

  // Apply checkbox patches for each slice
  let updated = content;
  for (const slice of slices) {
    const isDone = slice.status === "complete";
    const sid = slice.id;

    if (isDone) {
      // Set [x]: replace "- [ ] **S01:" with "- [x] **S01:"
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${sid}:`, "m"),
        `$1[x] **${sid}:`,
      );
    } else {
      // Set [ ]: replace "- [x] **S01:" with "- [ ] **S01:"
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[x\\]\\s+\\*\\*${sid}:`, "mi"),
        `$1[ ] **${sid}:`,
      );
    }
  }

  if (!absPath) return false;

  await writeAndStore(absPath, artifactPath!, updated, {
    artifact_type: "ROADMAP",
    milestone_id: milestoneId,
  });

  return true;
}

// ─── Plan Checkbox Rendering ──────────────────────────────────────────────

/**
 * Render plan checkbox states from DB.
 *
 * For each task in the slice, sets [x] if status === 'done',
 * [ ] otherwise. Bidirectional.
 *
 * @returns true if the plan was written, false on skip/error
 */
export async function renderPlanCheckboxes(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<boolean> {
  const tasks = getSliceTasks(milestoneId, sliceId);
  if (tasks.length === 0) {
    process.stderr.write(
      `markdown-renderer: no tasks found for ${milestoneId}/${sliceId}\n`,
    );
    return false;
  }

  const absPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN");
  const artifactPath = absPath ? toArtifactPath(absPath, basePath) : null;

  let content: string | null = null;
  if (artifactPath) {
    content = loadArtifactContent(artifactPath, absPath, {
      artifact_type: "PLAN",
      milestone_id: milestoneId,
      slice_id: sliceId,
    });
  }

  if (!content) {
    process.stderr.write(
      `markdown-renderer: no plan content available for ${milestoneId}/${sliceId}\n`,
    );
    return false;
  }

  // Apply checkbox patches for each task
  let updated = content;
  for (const task of tasks) {
    const isDone = isClosedStatus(task.status);
    const tid = task.id;

    if (isDone) {
      // Set [x]
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${tid}:`, "m"),
        `$1[x] **${tid}:`,
      );
    } else {
      // Set [ ]
      updated = updated.replace(
        new RegExp(`^(\\s*-\\s+)\\[x\\]\\s+\\*\\*${tid}:`, "mi"),
        `$1[ ] **${tid}:`,
      );
    }
  }

  if (!absPath) return false;

  await writeAndStore(absPath, artifactPath!, updated, {
    artifact_type: "PLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
  });

  return true;
}

// ─── Task Summary Rendering ───────────────────────────────────────────────

/**
 * Render a task summary from DB to disk.
 * Reads full_summary_md from the tasks table and writes it to the appropriate file.
 *
 * @returns true if the summary was written, false on skip/error
 */
export async function renderTaskSummary(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<boolean> {
  const task = getTask(milestoneId, sliceId, taskId);
  if (!task || !task.full_summary_md) {
    return false; // No summary to render — skip silently
  }

  // Resolve the tasks directory, creating path if needed
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!slicePath) {
    process.stderr.write(
      `markdown-renderer: cannot resolve slice path for ${milestoneId}/${sliceId}\n`,
    );
    return false;
  }

  const tasksDir = join(slicePath, "tasks");
  const fileName = buildTaskFileName(taskId, "SUMMARY");
  const absPath = join(tasksDir, fileName);
  const artifactPath = toArtifactPath(absPath, basePath);

  await writeAndStore(absPath, artifactPath, task.full_summary_md, {
    artifact_type: "SUMMARY",
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: taskId,
  });

  return true;
}

// ─── Slice Summary Rendering ──────────────────────────────────────────────

/**
 * Render slice summary and UAT files from DB to disk.
 * Reads full_summary_md and full_uat_md from the slices table.
 *
 * @returns true if at least one file was written, false on skip/error
 */
export async function renderSliceSummary(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<boolean> {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice) {
    return false; // No slice data — skip silently
  }

  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!slicePath) {
    process.stderr.write(
      `markdown-renderer: cannot resolve slice path for ${milestoneId}/${sliceId}\n`,
    );
    return false;
  }

  let wrote = false;

  // Write SUMMARY
  if (slice.full_summary_md) {
    const summaryName = buildSliceFileName(sliceId, "SUMMARY");
    const summaryAbs = join(slicePath, summaryName);
    const summaryArtifact = toArtifactPath(summaryAbs, basePath);

    await writeAndStore(summaryAbs, summaryArtifact, slice.full_summary_md, {
      artifact_type: "SUMMARY",
      milestone_id: milestoneId,
      slice_id: sliceId,
    });
    wrote = true;
  }

  // Write UAT
  if (slice.full_uat_md) {
    const uatName = buildSliceFileName(sliceId, "UAT");
    const uatAbs = join(slicePath, uatName);
    const uatArtifact = toArtifactPath(uatAbs, basePath);

    await writeAndStore(uatAbs, uatArtifact, slice.full_uat_md, {
      artifact_type: "UAT",
      milestone_id: milestoneId,
      slice_id: sliceId,
    });
    wrote = true;
  }

  return wrote;
}

// ─── Render All From DB ───────────────────────────────────────────────────

export interface RenderAllResult {
  rendered: number;
  skipped: number;
  errors: string[];
}

/**
 * Iterate all milestones, slices, and tasks in the DB and render each artifact to disk.
 * Returns structured result for inspection.
 */
export async function renderAllFromDb(basePath: string): Promise<RenderAllResult> {
  const result: RenderAllResult = { rendered: 0, skipped: 0, errors: [] };
  const milestones = getAllMilestones();

  for (const milestone of milestones) {
    // Render roadmap checkboxes
    try {
      const ok = await renderRoadmapCheckboxes(basePath, milestone.id);
      if (ok) result.rendered++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`roadmap ${milestone.id}: ${(err as Error).message}`);
    }

    // Iterate slices
    const slices = getMilestoneSlices(milestone.id);
    for (const slice of slices) {
      // Render plan checkboxes
      try {
        const ok = await renderPlanCheckboxes(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `plan ${milestone.id}/${slice.id}: ${(err as Error).message}`,
        );
      }

      // Render slice summary
      try {
        const ok = await renderSliceSummary(basePath, milestone.id, slice.id);
        if (ok) result.rendered++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(
          `slice summary ${milestone.id}/${slice.id}: ${(err as Error).message}`,
        );
      }

      // Iterate tasks
      const tasks = getSliceTasks(milestone.id, slice.id);
      for (const task of tasks) {
        try {
          const ok = await renderTaskSummary(
            basePath,
            milestone.id,
            slice.id,
            task.id,
          );
          if (ok) result.rendered++;
          else result.skipped++;
        } catch (err) {
          result.errors.push(
            `task summary ${milestone.id}/${slice.id}/${task.id}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  return result;
}

// ─── Stale Detection ──────────────────────────────────────────────────────

export interface StaleEntry {
  path: string;
  reason: string;
}

/**
 * Detect stale renders by comparing DB state against file content.
 *
 * Checks:
 * 1. Roadmap checkbox states vs DB slice statuses
 * 2. Plan checkbox states vs DB task statuses
 * 3. Missing SUMMARY.md files for complete tasks with full_summary_md
 * 4. Missing SUMMARY.md/UAT.md files for complete slices with content
 *
 * Returns a list of stale entries with file path and reason.
 * Logs to stderr when stale files are detected.
 */
export function detectStaleRenders(basePath: string): StaleEntry[] {
  // Lazy-load parsers — intentional disk-vs-DB comparison requires parsers
  const _require = createRequire(import.meta.url);
  let parseRoadmap: Function, parsePlan: Function;
  try {
    const m = _require("./parsers-legacy.ts");
    parseRoadmap = m.parseRoadmap; parsePlan = m.parsePlan;
  } catch (e) {
    logWarning("renderer", `parsers-legacy.ts require failed, falling back to .js: ${(e as Error).message}`);
    const m = _require("./parsers-legacy.js");
    parseRoadmap = m.parseRoadmap; parsePlan = m.parsePlan;
  }

  const stale: StaleEntry[] = [];
  const milestones = getAllMilestones();

  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id);

    // ── Check roadmap checkbox state ──────────────────────────────────
    const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
    if (roadmapPath && existsSync(roadmapPath)) {
      try {
        const content = readFileSync(roadmapPath, "utf-8");
        const parsed = parseRoadmap(content);

        for (const slice of slices) {
          const isCompleteInDb = slice.status === "complete";
          const roadmapSlice = parsed.slices.find((s: { id: string }) => s.id === slice.id);
          if (!roadmapSlice) continue;

          if (isCompleteInDb && !roadmapSlice.done) {
            stale.push({
              path: roadmapPath,
              reason: `${slice.id} is complete in DB but unchecked in roadmap`,
            });
          } else if (!isCompleteInDb && roadmapSlice.done) {
            stale.push({
              path: roadmapPath,
              reason: `${slice.id} is not complete in DB but checked in roadmap`,
            });
          }
        }
      } catch (e) {
        logWarning("renderer", `roadmap parse failed: ${(e as Error).message}`);
      }
    }

    // ── Check plan checkbox state and summaries for each slice ────────
    for (const slice of slices) {
      const tasks = getSliceTasks(milestone.id, slice.id);

      // Check plan checkboxes
      const planPath = resolveSliceFile(basePath, milestone.id, slice.id, "PLAN");
      if (planPath && existsSync(planPath)) {
        try {
          const content = readFileSync(planPath, "utf-8");
          const parsed = parsePlan(content);

          for (const task of tasks) {
            const isDoneInDb = isClosedStatus(task.status);
            const planTask = parsed.tasks.find((t: { id: string }) => t.id === task.id);
            if (!planTask) continue;

            if (isDoneInDb && !planTask.done) {
              stale.push({
                path: planPath,
                reason: `${task.id} is done in DB but unchecked in plan`,
              });
            } else if (!isDoneInDb && planTask.done) {
              stale.push({
                path: planPath,
                reason: `${task.id} is not done in DB but checked in plan`,
              });
            }
          }
        } catch (e) {
          logWarning("renderer", `plan parse failed: ${(e as Error).message}`);
        }
      }

      // Check missing task summary files
      for (const task of tasks) {
        if (isClosedStatus(task.status) && task.full_summary_md) {
          const slicePath = resolveSlicePath(basePath, milestone.id, slice.id);
          if (slicePath) {
            const tasksDir = join(slicePath, "tasks");
            const fileName = buildTaskFileName(task.id, "SUMMARY");
            const summaryAbsPath = join(tasksDir, fileName);

            if (!existsSync(summaryAbsPath)) {
              stale.push({
                path: summaryAbsPath,
                reason: `${task.id} is complete with summary in DB but SUMMARY.md missing on disk`,
              });
            }
          }
        }
      }

      // Check missing slice summary/UAT files
      const sliceRow = getSlice(milestone.id, slice.id);
      if (sliceRow && sliceRow.status === "complete") {
        const slicePath = resolveSlicePath(basePath, milestone.id, slice.id);
        if (slicePath) {
          if (sliceRow.full_summary_md) {
            const summaryName = buildSliceFileName(slice.id, "SUMMARY");
            const summaryAbsPath = join(slicePath, summaryName);
            if (!existsSync(summaryAbsPath)) {
              stale.push({
                path: summaryAbsPath,
                reason: `${slice.id} is complete with summary in DB but SUMMARY.md missing on disk`,
              });
            }
          }

          if (sliceRow.full_uat_md) {
            const uatName = buildSliceFileName(slice.id, "UAT");
            const uatAbsPath = join(slicePath, uatName);
            if (!existsSync(uatAbsPath)) {
              stale.push({
                path: uatAbsPath,
                reason: `${slice.id} is complete with UAT in DB but UAT.md missing on disk`,
              });
            }
          }
        }
      }
    }
  }

  if (stale.length > 0) {
    process.stderr.write(
      `markdown-renderer: detected ${stale.length} stale render(s):\n`,
    );
    for (const entry of stale) {
      process.stderr.write(`  - ${entry.path}: ${entry.reason}\n`);
    }
  }

  return stale;
}

// ─── Stale Repair ─────────────────────────────────────────────────────────

/**
 * Repair all stale renders detected by `detectStaleRenders()`.
 *
 * For each stale entry, calls the appropriate render function:
 * - Roadmap checkbox mismatches → renderRoadmapCheckboxes()
 * - Plan checkbox mismatches → renderPlanCheckboxes()
 * - Missing task summaries → renderTaskSummary()
 * - Missing slice summaries/UATs → renderSliceSummary()
 *
 * Idempotent: calling twice with no DB changes produces zero repairs on the second call.
 *
 * @returns the number of files repaired
 */
export async function repairStaleRenders(basePath: string): Promise<number> {
  const staleEntries = detectStaleRenders(basePath);
  if (staleEntries.length === 0) return 0;

  // Deduplicate: a single roadmap/plan file might appear multiple times
  // (once per mismatched checkbox). We only need to re-render it once.
  const repairedPaths = new Set<string>();
  let repairCount = 0;

  for (const entry of staleEntries) {
    if (repairedPaths.has(entry.path)) continue;
    // Normalize path separators for cross-platform regex matching
    const normPath = entry.path.replace(/\\/g, "/");

    try {
      // Determine repair action from the reason
      if (entry.reason.includes("in roadmap")) {
        // Roadmap checkbox mismatch — extract milestone ID from path
        const milestoneMatch = normPath.match(/milestones\/([^/]+)\//);
        if (milestoneMatch) {
          const ok = await renderRoadmapCheckboxes(basePath, milestoneMatch[1]);
          if (ok) {
            repairedPaths.add(entry.path);
            repairCount++;
          }
        }
      } else if (entry.reason.includes("in plan")) {
        // Plan checkbox mismatch — extract milestone + slice IDs from path
        const pathMatch = normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\//);
        if (pathMatch) {
          const ok = await renderPlanCheckboxes(basePath, pathMatch[1], pathMatch[2]);
          if (ok) {
            repairedPaths.add(entry.path);
            repairCount++;
          }
        }
      } else if (entry.reason.includes("SUMMARY.md missing") && entry.reason.match(/^T\d+/)) {
        // Missing task summary — extract IDs from path
        const pathMatch = normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\/tasks\//);
        const taskMatch = entry.reason.match(/^(T\d+)/);
        if (pathMatch && taskMatch) {
          const ok = await renderTaskSummary(basePath, pathMatch[1], pathMatch[2], taskMatch[1]);
          if (ok) {
            repairedPaths.add(entry.path);
            repairCount++;
          }
        }
      } else if (entry.reason.includes("SUMMARY.md missing") && entry.reason.match(/^S\d+/)) {
        // Missing slice summary — extract IDs from path
        const pathMatch = normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\//);
        if (pathMatch) {
          const ok = await renderSliceSummary(basePath, pathMatch[1], pathMatch[2]);
          if (ok) {
            repairedPaths.add(entry.path);
            repairCount++;
          }
        }
      } else if (entry.reason.includes("UAT.md missing")) {
        // Missing slice UAT — renderSliceSummary handles both SUMMARY + UAT
        const pathMatch = normPath.match(/milestones\/([^/]+)\/slices\/([^/]+)\//);
        if (pathMatch) {
          const ok = await renderSliceSummary(basePath, pathMatch[1], pathMatch[2]);
          if (ok) {
            repairedPaths.add(entry.path);
            repairCount++;
          }
        }
      }
    } catch (err) {
      logWarning("renderer", `repair failed for ${entry.path}: ${(err as Error).message}`);
    }
  }

  if (repairCount > 0) {
    process.stderr.write(
      `markdown-renderer: repaired ${repairCount} stale render(s)\n`,
    );
  }

  return repairCount;
}

// ─── Replan & Assessment Renderers ────────────────────────────────────────

export interface ReplanData {
  blockerTaskId: string;
  blockerDescription: string;
  whatChanged: string;
}

export interface AssessmentData {
  verdict: string;
  assessment: string;
  completedSliceId?: string;
}

export async function renderReplanFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  replanData: ReplanData,
): Promise<{ replanPath: string; content: string }> {
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId)
    ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
  const absPath = join(slicePath, `${sliceId}-REPLAN.md`);
  const artifactPath = toArtifactPath(absPath, basePath);

  const lines: string[] = [];
  lines.push(`# ${sliceId} Replan`);
  lines.push("");
  lines.push(`**Milestone:** ${milestoneId}`);
  lines.push(`**Slice:** ${sliceId}`);
  lines.push(`**Blocker Task:** ${replanData.blockerTaskId}`);
  lines.push(`**Created:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Blocker Description");
  lines.push("");
  lines.push(replanData.blockerDescription);
  lines.push("");
  lines.push("## What Changed");
  lines.push("");
  lines.push(replanData.whatChanged);
  lines.push("");

  const content = `${lines.join("\n").trimEnd()}\n`;

  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "REPLAN",
    milestone_id: milestoneId,
    slice_id: sliceId,
  });

  return { replanPath: absPath, content };
}

export async function renderAssessmentFromDb(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  assessmentData: AssessmentData,
): Promise<{ assessmentPath: string; content: string }> {
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId)
    ?? join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
  const absPath = join(slicePath, `${sliceId}-ASSESSMENT.md`);
  const artifactPath = toArtifactPath(absPath, basePath);

  const lines: string[] = [];
  lines.push(`# ${sliceId} Assessment`);
  lines.push("");
  lines.push(`**Milestone:** ${milestoneId}`);
  lines.push(`**Slice:** ${sliceId}`);
  if (assessmentData.completedSliceId) {
    lines.push(`**Completed Slice:** ${assessmentData.completedSliceId}`);
  }
  lines.push(`**Verdict:** ${assessmentData.verdict}`);
  lines.push(`**Created:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Assessment");
  lines.push("");
  lines.push(assessmentData.assessment);
  lines.push("");

  const content = `${lines.join("\n").trimEnd()}\n`;

  await writeAndStore(absPath, artifactPath, content, {
    artifact_type: "ASSESSMENT",
    milestone_id: milestoneId,
    slice_id: sliceId,
  });

  return { assessmentPath: absPath, content };
}
