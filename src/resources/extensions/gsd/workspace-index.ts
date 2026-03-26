import { join } from "node:path";

import { loadFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { parseRoadmap, parsePlan } from "./parsers-legacy.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveTasksDir,
} from "./paths.js";
import { deriveState } from "./state.js";
import { milestoneIdSort, findMilestoneIds } from "./guided-flow.js";
import type { RiskLevel } from "./types.js";
import { getSliceBranchName, detectWorktreeName } from "./worktree.js";

export interface WorkspaceTaskTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
}

export interface WorkspaceSliceTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
  uatPath?: string;
  tasksDir?: string;
  branch?: string;
  risk?: RiskLevel;
  depends?: string[];
  demo?: string;
  tasks: WorkspaceTaskTarget[];
}

export interface WorkspaceMilestoneTarget {
  id: string;
  title: string;
  roadmapPath?: string;
  slices: WorkspaceSliceTarget[];
}

export interface WorkspaceScopeTarget {
  scope: string;
  label: string;
  kind: "project" | "milestone" | "slice" | "task";
}

export interface GSDWorkspaceIndex {
  milestones: WorkspaceMilestoneTarget[];
  active: {
    milestoneId?: string;
    sliceId?: string;
    taskId?: string;
    phase: string;
  };
  scopes: WorkspaceScopeTarget[];
  validationIssues: Array<Record<string, unknown>>;
}

// Extract milestone title from roadmap header without using parsers.
// Falls back to the milestone ID if no title line found.
function titleFromRoadmapHeader(content: string, fallbackId: string): string {
  // Parse the "# M001: Title" header directly
  const match = content.match(/^#\s+M\d+(?:-[a-z0-9]{6})?[^:]*:\s*(.+)/m);
  return match?.[1]?.trim() || fallbackId;
}

async function indexSlice(basePath: string, milestoneId: string, sliceId: string, fallbackTitle: string, done: boolean, roadmapMeta?: { risk?: RiskLevel; depends?: string[]; demo?: string }): Promise<WorkspaceSliceTarget> {
  const planPath = resolveSliceFile(basePath, milestoneId, sliceId, "PLAN") ?? undefined;
  const summaryPath = resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY") ?? undefined;
  const uatPath = resolveSliceFile(basePath, milestoneId, sliceId, "UAT") ?? undefined;
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId) ?? undefined;

  const tasks: WorkspaceTaskTarget[] = [];
  let title = fallbackTitle;

  // Prefer DB for task data, fall back to file parsing when DB has no data
  let usedDb = false;
  if (isDbAvailable()) {
    const dbTasks = getSliceTasks(milestoneId, sliceId);
    if (dbTasks.length > 0) {
      usedDb = true;
      for (const task of dbTasks) {
        title = fallbackTitle; // title comes from slice-level data, not plan
        tasks.push({
          id: task.id,
          title: task.title,
          done: task.status === "complete" || task.status === "done",
          planPath: resolveTaskFile(basePath, milestoneId, sliceId, task.id, "PLAN") ?? undefined,
          summaryPath: resolveTaskFile(basePath, milestoneId, sliceId, task.id, "SUMMARY") ?? undefined,
        });
      }
    }
  }
  if (!usedDb && planPath) {
    // File-based fallback: parse slice plan for task entries
    const planContent = await loadFile(planPath);
    if (planContent) {
      const parsed = parsePlan(planContent);
      for (const task of parsed.tasks) {
        tasks.push({
          id: task.id,
          title: task.title,
          done: task.done,
          planPath: resolveTaskFile(basePath, milestoneId, sliceId, task.id, "PLAN") ?? undefined,
          summaryPath: resolveTaskFile(basePath, milestoneId, sliceId, task.id, "SUMMARY") ?? undefined,
        });
      }
    }
  }

  return {
    id: sliceId,
    title,
    done,
    planPath,
    summaryPath,
    uatPath,
    tasksDir,
    branch: getSliceBranchName(milestoneId, sliceId, detectWorktreeName(basePath)),
    risk: roadmapMeta?.risk,
    depends: roadmapMeta?.depends,
    demo: roadmapMeta?.demo,
    tasks,
  };
}

export interface IndexWorkspaceOptions {
  validate?: boolean;
}

export async function indexWorkspace(basePath: string, opts: IndexWorkspaceOptions = {}): Promise<GSDWorkspaceIndex> {
  const milestoneIds = findMilestoneIds(basePath);
  const milestones: WorkspaceMilestoneTarget[] = [];

  for (const milestoneId of milestoneIds) {
    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP") ?? undefined;
    let title = milestoneId;
    const slices: WorkspaceSliceTarget[] = [];

    if (roadmapPath || isDbAvailable()) {
      // Normalize slices from DB, fall back to file-based parsing when DB has no data
      type NormSlice = { id: string; done: boolean; title: string; risk: string; depends: string[]; demo: string };
      let normSlices: NormSlice[] | null = null;
      if (isDbAvailable()) {
        const dbSlices = getMilestoneSlices(milestoneId);
        if (dbSlices.length > 0) {
          normSlices = dbSlices.map(s => ({ id: s.id, done: s.status === "complete", title: s.title, risk: s.risk || "medium", depends: s.depends, demo: s.demo }));
        }
        // Get title from roadmap header
        if (roadmapPath) {
          const roadmapContent = await loadFile(roadmapPath);
          if (roadmapContent) title = titleFromRoadmapHeader(roadmapContent, milestoneId);
        }
      }
      if (!normSlices && roadmapPath) {
        // File-based fallback: parse roadmap for slice entries
        const roadmapContent = await loadFile(roadmapPath);
        if (roadmapContent) {
          title = titleFromRoadmapHeader(roadmapContent, milestoneId);
          const parsed = parseRoadmap(roadmapContent);
          normSlices = parsed.slices.map(s => ({ id: s.id, done: s.done, title: s.title, risk: s.risk || "medium", depends: s.depends, demo: s.demo || "" }));
        }
      }
      if (!normSlices) normSlices = [];

      if (normSlices.length > 0) {
        const sliceResults = await Promise.all(
          normSlices.map(async (slice) => {
            return indexSlice(basePath, milestoneId, slice.id, slice.title, slice.done, { risk: slice.risk as RiskLevel, depends: slice.depends, demo: slice.demo });
          }),
        );

        slices.push(...sliceResults);
      }
    }

    milestones.push({ id: milestoneId, title, roadmapPath, slices });
  }

  const state = await deriveState(basePath);
  const active = {
    milestoneId: state.activeMilestone?.id,
    sliceId: state.activeSlice?.id,
    taskId: state.activeTask?.id,
    phase: state.phase,
  };

  const scopes: WorkspaceScopeTarget[] = [{ scope: "project", label: "project", kind: "project" }];
  for (const milestone of milestones) {
    scopes.push({ scope: milestone.id, label: `${milestone.id}: ${milestone.title}`, kind: "milestone" });
    for (const slice of milestone.slices) {
      scopes.push({ scope: `${milestone.id}/${slice.id}`, label: `${milestone.id}/${slice.id}: ${slice.title}`, kind: "slice" });
      for (const task of slice.tasks) {
        scopes.push({
          scope: `${milestone.id}/${slice.id}/${task.id}`,
          label: `${milestone.id}/${slice.id}/${task.id}: ${task.title}`,
          kind: "task",
        });
      }
    }
  }

  return { milestones, active, scopes, validationIssues: [] };
}

export async function listDoctorScopeSuggestions(basePath: string): Promise<Array<{ value: string; label: string }>> {
  const index = await indexWorkspace(basePath);
  const activeSliceScope = index.active.milestoneId && index.active.sliceId
    ? `${index.active.milestoneId}/${index.active.sliceId}`
    : null;

  const ordered = [...index.scopes].filter(scope => scope.kind !== "project");
  ordered.sort((a, b) => {
    if (activeSliceScope && a.scope === activeSliceScope) return -1;
    if (activeSliceScope && b.scope === activeSliceScope) return 1;
    return a.scope.localeCompare(b.scope);
  });

  return ordered.map(scope => ({ value: scope.scope, label: scope.label }));
}

export async function getSuggestedNextCommands(basePath: string): Promise<string[]> {
  const index = await indexWorkspace(basePath);
  const scope = index.active.milestoneId && index.active.sliceId
    ? `${index.active.milestoneId}/${index.active.sliceId}`
    : index.active.milestoneId;

  const commands = new Set<string>();
  if (index.active.phase === "planning") commands.add("/gsd");
  if (index.active.phase === "executing" || index.active.phase === "summarizing") commands.add("/gsd auto");
  if (scope) commands.add(`/gsd doctor ${scope}`);
  if (scope) commands.add(`/gsd doctor fix ${scope}`);
  commands.add("/gsd status");
  return [...commands];
}
