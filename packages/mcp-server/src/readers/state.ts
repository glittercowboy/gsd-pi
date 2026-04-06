// GSD MCP Server — project state reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import {
  resolveGsdRoot,
  resolveRootFile,
  findMilestoneIds,
  resolveMilestoneDir,
  resolveMilestoneFile,
  findSliceIds,
  findTaskFiles,
} from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressResult {
  activeMilestone: { id: string; title: string } | null;
  activeSlice: { id: string; title: string } | null;
  activeTask: { id: string; title: string } | null;
  phase: string;
  milestones: { total: number; done: number; active: number; pending: number; parked: number };
  slices: { total: number; done: number; active: number; pending: number };
  tasks: { total: number; done: number; pending: number };
  requirements: { active: number; validated: number; deferred: number; outOfScope: number } | null;
  blockers: string[];
  nextAction: string;
}

// ---------------------------------------------------------------------------
// STATE.md parser
// ---------------------------------------------------------------------------

function parseBoldField(content: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function parseActiveRef(value: string | null): { id: string; title: string } | null {
  if (!value || value.toLowerCase() === 'none' || value === '—') return null;
  // "M001: Flight Simulator" or "M001"
  const m = value.match(/^(M\d+|S\d+|T\d+):?\s*(.*)/);
  if (m) return { id: m[1], title: m[2] || m[1] };
  return { id: value, title: value };
}

function parsePhase(value: string | null): string {
  if (!value) return 'unknown';
  const lower = value.toLowerCase().trim();
  if (lower.includes('research') || lower.includes('discuss')) return 'research';
  if (lower.includes('plan')) return 'plan';
  if (lower.includes('execut')) return 'execute';
  if (lower.includes('complete') || lower.includes('done')) return 'complete';
  return lower;
}

function parseRequirementsLine(value: string | null): ProgressResult['requirements'] | null {
  if (!value) return null;
  const active = value.match(/(\d+)\s*active/i);
  const validated = value.match(/(\d+)\s*validated/i);
  const deferred = value.match(/(\d+)\s*deferred/i);
  const outOfScope = value.match(/(\d+)\s*out.of.scope/i);
  if (!active && !validated && !deferred && !outOfScope) return null;
  return {
    active: active ? parseInt(active[1], 10) : 0,
    validated: validated ? parseInt(validated[1], 10) : 0,
    deferred: deferred ? parseInt(deferred[1], 10) : 0,
    outOfScope: outOfScope ? parseInt(outOfScope[1], 10) : 0,
  };
}

function parseBlockers(content: string): string[] {
  const section = content.match(/## Blockers\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (!section) return [];
  return section[1]
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function parseNextAction(content: string): string {
  const section = content.match(/## Next Action\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (!section) return '';
  return section[1].trim().split('\n')[0] || '';
}

// ---------------------------------------------------------------------------
// Milestone registry from STATE.md
// ---------------------------------------------------------------------------

interface RegistryEntry { id: string; status: 'done' | 'active' | 'pending' | 'parked' }

function parseMilestoneRegistry(content: string): RegistryEntry[] {
  const section = content.match(/## Milestone Registry\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (!section) return [];
  const entries: RegistryEntry[] = [];
  for (const line of section[1].split('\n')) {
    const m = line.match(/[-*]\s*(☑|✅|🔄|⬜|⏸)\s*\*\*(M\d+):\*\*/);
    if (!m) continue;
    const [, icon, id] = m;
    let status: RegistryEntry['status'] = 'pending';
    if (icon === '☑' || icon === '✅') status = 'done';
    else if (icon === '🔄') status = 'active';
    else if (icon === '⏸') status = 'parked';
    entries.push({ id, status });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Count slices/tasks by walking filesystem
// ---------------------------------------------------------------------------

function countSlicesAndTasks(gsdRoot: string, milestoneIds: string[]): {
  slices: ProgressResult['slices'];
  tasks: ProgressResult['tasks'];
} {
  let sliceTotal = 0, sliceDone = 0, sliceActive = 0;
  let taskTotal = 0, taskDone = 0;

  for (const mid of milestoneIds) {
    const sliceIds = findSliceIds(gsdRoot, mid);
    sliceTotal += sliceIds.length;

    for (const sid of sliceIds) {
      const tasks = findTaskFiles(gsdRoot, mid, sid);
      taskTotal += tasks.length;

      const allDone = tasks.length > 0 && tasks.every((t) => t.hasSummary);
      const anyDone = tasks.some((t) => t.hasSummary);

      if (allDone) {
        sliceDone++;
        taskDone += tasks.length;
      } else {
        if (anyDone) sliceActive++;
        taskDone += tasks.filter((t) => t.hasSummary).length;
      }
    }
  }

  return {
    slices: {
      total: sliceTotal,
      done: sliceDone,
      active: sliceActive,
      pending: sliceTotal - sliceDone - sliceActive,
    },
    tasks: { total: taskTotal, done: taskDone, pending: taskTotal - taskDone },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readProgress(projectDir: string): ProgressResult {
  const gsd = resolveGsdRoot(projectDir);
  const statePath = resolveRootFile(gsd, 'STATE.md');

  // Defaults
  const result: ProgressResult = {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: 'unknown',
    milestones: { total: 0, done: 0, active: 0, pending: 0, parked: 0 },
    slices: { total: 0, done: 0, active: 0, pending: 0 },
    tasks: { total: 0, done: 0, pending: 0 },
    requirements: null,
    blockers: [],
    nextAction: '',
  };

  if (!existsSync(statePath)) {
    // No STATE.md — derive from filesystem only
    const milestoneIds = findMilestoneIds(gsd);
    result.milestones.total = milestoneIds.length;
    result.milestones.pending = milestoneIds.length;
    const counts = countSlicesAndTasks(gsd, milestoneIds);
    result.slices = counts.slices;
    result.tasks = counts.tasks;
    return result;
  }

  const content = readFileSync(statePath, 'utf-8');

  // Parse STATE.md fields
  result.activeMilestone = parseActiveRef(parseBoldField(content, 'Active Milestone'));
  result.activeSlice = parseActiveRef(parseBoldField(content, 'Active Slice'));
  result.activeTask = parseActiveRef(parseBoldField(content, 'Active Task'));
  result.phase = parsePhase(parseBoldField(content, 'Phase'));
  result.requirements = parseRequirementsLine(parseBoldField(content, 'Requirements Status'));
  result.blockers = parseBlockers(content);
  result.nextAction = parseNextAction(content);

  // Milestone counts from registry
  const registry = parseMilestoneRegistry(content);
  if (registry.length > 0) {
    result.milestones.total = registry.length;
    result.milestones.done = registry.filter((e) => e.status === 'done').length;
    result.milestones.active = registry.filter((e) => e.status === 'active').length;
    result.milestones.parked = registry.filter((e) => e.status === 'parked').length;
    result.milestones.pending = registry.length -
      result.milestones.done - result.milestones.active - result.milestones.parked;
  } else {
    // Fallback: count directories
    const milestoneIds = findMilestoneIds(gsd);
    result.milestones.total = milestoneIds.length;
    result.milestones.pending = milestoneIds.length;
  }

  // Slice/task counts from filesystem
  const milestoneIds = findMilestoneIds(gsd);
  const counts = countSlicesAndTasks(gsd, milestoneIds);
  result.slices = counts.slices;
  result.tasks = counts.tasks;

  return result;
}
