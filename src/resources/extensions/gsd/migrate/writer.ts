// GSD Directory Writer — Format Functions & Directory Orchestrator
// Format functions: pure string-returning functions that serialize GSD types into the exact markdown
// format that GSD-2's parsers expect (parseRoadmap, parsePlan, parseSummary, parseRequirementCounts).
// writeGSDDirectory: orchestrator that writes a complete .gsd directory tree from a GSDProject.

import { join } from 'node:path';
import { saveFile } from '../files.js';
import { gsdRoot } from '../paths.js';

import type {
  GSDMilestone,
  GSDSlice,
  GSDTask,
  GSDRequirement,
  GSDProject,
} from './types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Result of writeGSDDirectory — lists all files that were written. */
export interface WrittenFiles {
  /** Absolute paths of all files written */
  paths: string[];
  /** Count by category */
  counts: {
    roadmaps: number;
    plans: number;
    taskPlans: number;
    taskSummaries: number;
    sliceSummaries: number;
    research: number;
    requirements: number;
    contexts: number;
    other: number;
  };
}

/** Pre-write statistics computed from a GSDProject without I/O. */
export interface MigrationPreview {
  milestoneCount: number;
  totalSlices: number;
  totalTasks: number;
  doneSlices: number;
  doneTasks: number;
  sliceCompletionPct: number;
  taskCompletionPct: number;
  requirements: {
    active: number;
    validated: number;
    deferred: number;
    outOfScope: number;
    total: number;
  };
}

// ─── Local Helpers ─────────────────────────────────────────────────────────

/**
 * Serialize a flat key-value map into YAML frontmatter block.
 * Matches parseFrontmatterMap() expectations:
 * - Scalars: `key: value`
 * - Arrays of strings: `key:\n  - item`
 * - Empty arrays: `key: []`
 * - Arrays of objects: `key:\n  - field1: val\n    field2: val`
 * - Boolean: `key: true/false`
 */
function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;

    if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'string' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (typeof value[0] === 'object' && value[0] !== null) {
        // Array of objects
        lines.push(`${key}:`);
        for (const obj of value) {
          const entries = Object.entries(obj as Record<string, string>);
          if (entries.length > 0) {
            lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`);
            for (let i = 1; i < entries.length; i++) {
              lines.push(`    ${entries[i][0]}: ${entries[i][1]}`);
            }
          }
        }
      } else {
        // Array of scalars
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// ─── Format Functions ──────────────────────────────────────────────────────

/**
 * Format a milestone's ROADMAP.md content.
 * Output must parse correctly through parseRoadmap().
 */
export function formatRoadmap(milestone: GSDMilestone): string {
  const lines: string[] = [];

  lines.push(`# ${milestone.id}: ${milestone.title}`);
  lines.push('');
  lines.push(`**Vision:** ${milestone.vision || '(migrated project)'}`);
  lines.push('');

  lines.push('## Success Criteria');
  lines.push('');
  if (milestone.successCriteria.length > 0) {
    for (const criterion of milestone.successCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  lines.push('');

  lines.push('## Slices');
  lines.push('');
  for (const slice of milestone.slices) {
    const check = slice.done ? 'x' : ' ';
    const depsStr = slice.depends.length > 0 ? slice.depends.join(', ') : '';
    lines.push(`- [${check}] **${slice.id}: ${slice.title}** \`risk:${slice.risk}\` \`depends:[${depsStr}]\``);
    if (slice.demo) {
      lines.push(`  > After this: ${slice.demo}`);
    }
  }

  // Skip Boundary Map section entirely per D004

  return lines.join('\n') + '\n';
}

/**
 * Format a slice's PLAN.md (S01-PLAN.md).
 * Output must parse correctly through parsePlan().
 */
export function formatPlan(slice: GSDSlice): string {
  const lines: string[] = [];

  lines.push(`# ${slice.id}: ${slice.title}`);
  lines.push('');
  lines.push(`**Goal:** ${slice.goal || slice.title}`);
  lines.push(`**Demo:** ${slice.demo || slice.title}`);
  lines.push('');

  lines.push('## Must-Haves');
  lines.push('');
  // No must-haves in migrated data — empty section
  lines.push('');

  lines.push('## Tasks');
  lines.push('');
  for (const task of slice.tasks) {
    const check = task.done ? 'x' : ' ';
    const estPart = task.estimate ? ` \`est:${task.estimate}\`` : '';
    lines.push(`- [${check}] **${task.id}: ${task.title}**${estPart}`);
    if (task.description) {
      lines.push(`  - ${task.description}`);
    }
  }
  lines.push('');

  lines.push('## Files Likely Touched');
  lines.push('');
  for (const task of slice.tasks) {
    for (const file of task.files) {
      lines.push(`- \`${file}\``);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Format a slice summary (S01-SUMMARY.md).
 * Output must parse correctly through parseSummary().
 */
export function formatSliceSummary(slice: GSDSlice, milestoneId: string): string {
  if (!slice.summary) return '';

  const s = slice.summary;
  const fm = serializeFrontmatter({
    id: slice.id,
    parent: milestoneId,
    milestone: milestoneId,
    provides: s.provides,
    requires: [],
    affects: [],
    key_files: s.keyFiles,
    key_decisions: s.keyDecisions,
    patterns_established: s.patternsEstablished,
    observability_surfaces: [],
    drill_down_paths: [],
    duration: s.duration || '',
    verification_result: 'passed',
    completed_at: s.completedAt || '',
    blocker_discovered: false,
  });

  const body = [
    '',
    `# ${slice.id}: ${slice.title}`,
    '',
    `**${s.whatHappened ? s.whatHappened.split('\n')[0] : 'Migrated from legacy format'}**`,
    '',
    '## What Happened',
    '',
    s.whatHappened || 'Migrated from legacy planning format.',
  ];

  return fm + body.join('\n') + '\n';
}

/**
 * Format a task summary (T01-SUMMARY.md).
 * Output must parse correctly through parseSummary().
 */
export function formatTaskSummary(task: GSDTask, sliceId: string, milestoneId: string): string {
  if (!task.summary) return '';

  const s = task.summary;
  const fm = serializeFrontmatter({
    id: task.id,
    parent: sliceId,
    milestone: milestoneId,
    provides: s.provides,
    requires: [],
    affects: [],
    key_files: s.keyFiles,
    key_decisions: [],
    patterns_established: [],
    observability_surfaces: [],
    drill_down_paths: [],
    duration: s.duration || '',
    verification_result: 'passed',
    completed_at: s.completedAt || '',
    blocker_discovered: false,
  });

  const body = [
    '',
    `# ${task.id}: ${task.title}`,
    '',
    `**${s.whatHappened ? s.whatHappened.split('\n')[0] : 'Migrated from legacy format'}**`,
    '',
    '## What Happened',
    '',
    s.whatHappened || 'Migrated from legacy planning format.',
  ];

  return fm + body.join('\n') + '\n';
}

/**
 * Format a task plan (T01-PLAN.md).
 * deriveState() only checks for file existence, not content.
 * Keep it minimal but valid markdown.
 */
export function formatTaskPlan(task: GSDTask, sliceId: string, milestoneId: string): string {
  const lines: string[] = [];
  lines.push(`# ${task.id}: ${task.title}`);
  lines.push('');
  lines.push(`**Slice:** ${sliceId} — **Milestone:** ${milestoneId}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(task.description || 'Migrated from legacy planning format.');
  lines.push('');

  if (task.mustHaves.length > 0) {
    lines.push('## Must-Haves');
    lines.push('');
    for (const mh of task.mustHaves) {
      lines.push(`- [ ] ${mh}`);
    }
    lines.push('');
  }

  if (task.files.length > 0) {
    lines.push('## Files');
    lines.push('');
    for (const f of task.files) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format REQUIREMENTS.md grouped by status.
 * Output must parse correctly through parseRequirementCounts().
 * parseRequirementCounts expects: ## Active/## Validated/## Deferred/## Out of Scope sections
 * with ### R001 — Title headings under each section.
 */
export function formatRequirements(requirements: GSDRequirement[]): string {
  const lines: string[] = [];
  lines.push('# Requirements');
  lines.push('');

  const groups: Record<string, GSDRequirement[]> = {
    active: [],
    validated: [],
    deferred: [],
    'out-of-scope': [],
  };

  for (const req of requirements) {
    const status = req.status.toLowerCase();
    if (status in groups) {
      groups[status].push(req);
    } else {
      groups.active.push(req);
    }
  }

  const sectionMap: [string, string][] = [
    ['active', 'Active'],
    ['validated', 'Validated'],
    ['deferred', 'Deferred'],
    ['out-of-scope', 'Out of Scope'],
  ];

  for (const [key, heading] of sectionMap) {
    lines.push(`## ${heading}`);
    lines.push('');
    for (const req of groups[key]) {
      lines.push(`### ${req.id} — ${req.title}`);
      lines.push('');
      lines.push(`- Status: ${req.status}`);
      lines.push(`- Class: ${req.class}`);
      lines.push(`- Source: ${req.source}`);
      lines.push(`- Primary Slice: ${req.primarySlice}`);
      lines.push('');
      if (req.description) {
        lines.push(req.description);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Passthrough Format Helpers ────────────────────────────────────────────

/**
 * Format PROJECT.md content.
 * If content is empty, produce a minimal valid stub.
 */
export function formatProject(content: string): string {
  if (!content || !content.trim()) {
    return '# Project\n\n(Migrated project — no description available.)\n';
  }
  return content.endsWith('\n') ? content : content + '\n';
}

/**
 * Format DECISIONS.md content.
 * If content is empty, produce the standard header.
 */
export function formatDecisions(content: string): string {
  if (!content || !content.trim()) {
    return '# Decisions\n\n<!-- Append-only register of architectural and pattern decisions -->\n\n| ID | Decision | Rationale | Date |\n|----|----------|-----------|------|\n';
  }
  return content.endsWith('\n') ? content : content + '\n';
}

/**
 * Format a milestone CONTEXT.md.
 * Minimal context with no depends — migrated milestones have no upstream dependencies.
 */
export function formatContext(milestoneId: string): string {
  return `# ${milestoneId} Context\n\nMigrated milestone — no upstream dependencies.\n`;
}

/**
 * Format STATE.md.
 * deriveState() does not read STATE.md — it recomputes from scratch.
 * Write a minimal stub that will be overwritten on first /gsd status.
 */
export function formatState(milestones: GSDMilestone[]): string {
  const lines: string[] = [];
  lines.push('# GSD State');
  lines.push('');
  lines.push('<!-- Auto-generated. Updated by deriveState(). -->');
  lines.push('');
  for (const m of milestones) {
    const doneSlices = m.slices.filter(s => s.done).length;
    const totalSlices = m.slices.length;
    lines.push(`## ${m.id}: ${m.title}`);
    lines.push('');
    lines.push(`- Slices: ${doneSlices}/${totalSlices}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Directory Writer Orchestrator ─────────────────────────────────────────

/**
 * Write a complete .gsd directory tree from a GSDProject.
 * Iterates milestones → slices → tasks, calls format functions,
 * and writes each file via saveFile(). Returns a manifest of written paths.
 *
 * Skips research/summary files when null (does not write empty stubs).
 */
export async function writeGSDDirectory(
  project: GSDProject,
  targetPath: string,
): Promise<WrittenFiles> {
  const gsdDir = gsdRoot(targetPath);
  const milestonesBase = join(gsdDir, 'milestones');
  const paths: string[] = [];
  const counts: WrittenFiles['counts'] = {
    roadmaps: 0,
    plans: 0,
    taskPlans: 0,
    taskSummaries: 0,
    sliceSummaries: 0,
    research: 0,
    requirements: 0,
    contexts: 0,
    other: 0,
  };

  // Root-level files
  const projectPath = join(gsdDir, 'PROJECT.md');
  await saveFile(projectPath, formatProject(project.projectContent));
  paths.push(projectPath);
  counts.other++;

  const decisionsPath = join(gsdDir, 'DECISIONS.md');
  await saveFile(decisionsPath, formatDecisions(project.decisionsContent));
  paths.push(decisionsPath);
  counts.other++;

  const statePath = join(gsdDir, 'STATE.md');
  await saveFile(statePath, formatState(project.milestones));
  paths.push(statePath);
  counts.other++;

  if (project.requirements.length > 0) {
    const reqPath = join(gsdDir, 'REQUIREMENTS.md');
    await saveFile(reqPath, formatRequirements(project.requirements));
    paths.push(reqPath);
    counts.requirements++;
  }

  // Milestones
  for (const milestone of project.milestones) {
    const mDir = join(milestonesBase, milestone.id);

    // Roadmap (always written, even for empty milestones)
    const roadmapPath = join(mDir, `${milestone.id}-ROADMAP.md`);
    await saveFile(roadmapPath, formatRoadmap(milestone));
    paths.push(roadmapPath);
    counts.roadmaps++;

    // Context
    const contextPath = join(mDir, `${milestone.id}-CONTEXT.md`);
    await saveFile(contextPath, formatContext(milestone.id));
    paths.push(contextPath);
    counts.contexts++;

    // Research (skip if null)
    if (milestone.research !== null) {
      const researchPath = join(mDir, `${milestone.id}-RESEARCH.md`);
      await saveFile(researchPath, milestone.research);
      paths.push(researchPath);
      counts.research++;
    }

    // For fully-completed milestones (all slices done), write a pass-through
    // validation file so deriveState() doesn't enter validating-milestone
    // phase for historical milestones that predate the validation gate (#819).
    const allSlicesDone = milestone.slices.length > 0 && milestone.slices.every(s => s.done);
    if (allSlicesDone) {
      const validationPath = join(mDir, `${milestone.id}-VALIDATION.md`);
      const validationContent = [
        `---`,
        `verdict: pass`,
        `migrated: true`,
        `---`,
        ``,
        `# ${milestone.id} Validation`,
        ``,
        `Migrated milestone — all slices were completed in the original project.`,
        ``,
      ].join('\n');
      await saveFile(validationPath, validationContent);
      paths.push(validationPath);
      counts.other++;

      // Also write a milestone summary if one doesn't exist
      const summaryPath = join(mDir, `${milestone.id}-SUMMARY.md`);
      const summaryContent = [
        `---`,
        `status: done`,
        `migrated: true`,
        `---`,
        ``,
        `# ${milestone.id}: ${milestone.title}`,
        ``,
        `Migrated from .planning — ${milestone.slices.length} slices completed.`,
        ``,
      ].join('\n');
      await saveFile(summaryPath, summaryContent);
      paths.push(summaryPath);
      counts.other++;
    }

    // Slices
    for (const slice of milestone.slices) {
      const sDir = join(mDir, 'slices', slice.id);
      const tasksDir = join(sDir, 'tasks');

      // Slice plan
      const planPath = join(sDir, `${slice.id}-PLAN.md`);
      await saveFile(planPath, formatPlan(slice));
      paths.push(planPath);
      counts.plans++;

      // Slice research (skip if null)
      if (slice.research !== null) {
        const sliceResearchPath = join(sDir, `${slice.id}-RESEARCH.md`);
        await saveFile(sliceResearchPath, slice.research);
        paths.push(sliceResearchPath);
        counts.research++;
      }

      // Slice summary (skip if null)
      if (slice.summary !== null) {
        const summaryContent = formatSliceSummary(slice, milestone.id);
        if (summaryContent) {
          const summaryPath = join(sDir, `${slice.id}-SUMMARY.md`);
          await saveFile(summaryPath, summaryContent);
          paths.push(summaryPath);
          counts.sliceSummaries++;
        }
      }

      // Tasks
      for (const task of slice.tasks) {
        // Task plan (always written)
        const taskPlanPath = join(tasksDir, `${task.id}-PLAN.md`);
        await saveFile(taskPlanPath, formatTaskPlan(task, slice.id, milestone.id));
        paths.push(taskPlanPath);
        counts.taskPlans++;

        // Task summary (skip if null)
        if (task.summary !== null) {
          const taskSummaryContent = formatTaskSummary(task, slice.id, milestone.id);
          if (taskSummaryContent) {
            const taskSummaryPath = join(tasksDir, `${task.id}-SUMMARY.md`);
            await saveFile(taskSummaryPath, taskSummaryContent);
            paths.push(taskSummaryPath);
            counts.taskSummaries++;
          }
        }
      }
    }
  }

  return { paths, counts };
}
