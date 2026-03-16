// Data loader for workflow visualizer overlay — aggregates state + metrics.

import { deriveState } from './state.js';
import { parseRoadmap, parsePlan, parseSummary, loadFile } from './files.js';
import { findMilestoneIds } from './guided-flow.js';
import { resolveMilestoneFile, resolveSliceFile } from './paths.js';
import {
  getLedger,
  getProjectTotals,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  loadLedgerFromDisk,
  classifyUnitPhase,
} from './metrics.js';

import type { Phase } from './types.js';
import type {
  ProjectTotals,
  PhaseAggregate,
  SliceAggregate,
  ModelAggregate,
  UnitMetrics,
} from './metrics.js';

// ─── Visualizer Types ─────────────────────────────────────────────────────────

export interface VisualizerMilestone {
  id: string;
  title: string;
  status: 'complete' | 'active' | 'pending';
  dependsOn: string[];
  slices: VisualizerSlice[];
}

export interface VisualizerSlice {
  id: string;
  title: string;
  done: boolean;
  active: boolean;
  risk: string;
  depends: string[];
  tasks: VisualizerTask[];
}

export interface VisualizerTask {
  id: string;
  title: string;
  done: boolean;
  active: boolean;
}

export interface CriticalPathInfo {
  milestonePath: string[];
  slicePath: string[];
  milestoneSlack: Map<string, number>;
  sliceSlack: Map<string, number>;
}

export interface AgentActivityInfo {
  currentUnit: { type: string; id: string; startedAt: number } | null;
  elapsed: number;
  completedUnits: number;
  totalSlices: number;
  completionRate: number;
  active: boolean;
  sessionCost: number;
  sessionTokens: number;
}

export interface ChangelogEntry {
  milestoneId: string;
  sliceId: string;
  title: string;
  oneLiner: string;
  filesModified: { path: string; description: string }[];
  completedAt: string;
}

export interface ChangelogInfo {
  entries: ChangelogEntry[];
}

export interface VisualizerData {
  milestones: VisualizerMilestone[];
  phase: Phase;
  totals: ProjectTotals | null;
  byPhase: PhaseAggregate[];
  bySlice: SliceAggregate[];
  byModel: ModelAggregate[];
  units: UnitMetrics[];
  criticalPath: CriticalPathInfo;
  remainingSliceCount: number;
  agentActivity: AgentActivityInfo | null;
  changelog: ChangelogInfo;
}

// ─── Critical Path ────────────────────────────────────────────────────────────

export function computeCriticalPath(milestones: VisualizerMilestone[]): CriticalPathInfo {
  const empty: CriticalPathInfo = {
    milestonePath: [],
    slicePath: [],
    milestoneSlack: new Map(),
    sliceSlack: new Map(),
  };

  if (milestones.length === 0) return empty;

  // Milestone-level critical path (weight = number of incomplete slices)
  const msMap = new Map(milestones.map(m => [m.id, m]));
  const msIds = milestones.map(m => m.id);
  const msAdj = new Map<string, string[]>();
  const msWeight = new Map<string, number>();

  for (const ms of milestones) {
    msAdj.set(ms.id, []);
    const incomplete = ms.slices.filter(s => !s.done).length;
    msWeight.set(ms.id, ms.status === 'complete' ? 0 : Math.max(1, incomplete));
  }

  for (const ms of milestones) {
    for (const dep of ms.dependsOn) {
      if (msMap.has(dep)) {
        const adj = msAdj.get(dep);
        if (adj) adj.push(ms.id);
      }
    }
  }

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  for (const id of msIds) inDegree.set(id, 0);
  for (const ms of milestones) {
    for (const dep of ms.dependsOn) {
      if (msMap.has(dep)) inDegree.set(ms.id, (inDegree.get(ms.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    topoOrder.push(node);
    for (const next of (msAdj.get(node) ?? [])) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // Longest path from each root
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const id of msIds) {
    dist.set(id, 0);
    prev.set(id, null);
  }

  for (const node of topoOrder) {
    const w = msWeight.get(node) ?? 1;
    const nodeDist = dist.get(node)! + w;
    for (const next of (msAdj.get(node) ?? [])) {
      if (nodeDist > dist.get(next)!) {
        dist.set(next, nodeDist);
        prev.set(next, node);
      }
    }
  }

  // Find the end of the critical path (node with max dist + own weight)
  let maxDist = 0;
  let endNode = msIds[0];
  for (const id of msIds) {
    const totalDist = dist.get(id)! + (msWeight.get(id) ?? 1);
    if (totalDist > maxDist) {
      maxDist = totalDist;
      endNode = id;
    }
  }

  // Trace back
  const milestonePath: string[] = [];
  let cur: string | null = endNode;
  while (cur !== null) {
    milestonePath.unshift(cur);
    cur = prev.get(cur) ?? null;
  }

  // Compute milestone slack
  const milestoneSlack = new Map<string, number>();
  const criticalSet = new Set(milestonePath);
  for (const id of msIds) {
    if (criticalSet.has(id)) {
      milestoneSlack.set(id, 0);
    } else {
      const nodeTotal = dist.get(id)! + (msWeight.get(id) ?? 1);
      milestoneSlack.set(id, Math.max(0, maxDist - nodeTotal));
    }
  }

  // Slice-level critical path within active milestone
  const activeMs = milestones.find(m => m.status === 'active');
  let slicePath: string[] = [];
  const sliceSlack = new Map<string, number>();

  if (activeMs && activeMs.slices.length > 0) {
    const slMap = new Map(activeMs.slices.map(s => [s.id, s]));
    const slAdj = new Map<string, string[]>();
    for (const s of activeMs.slices) slAdj.set(s.id, []);
    for (const s of activeMs.slices) {
      for (const dep of s.depends) {
        if (slMap.has(dep)) {
          const adj = slAdj.get(dep);
          if (adj) adj.push(s.id);
        }
      }
    }

    // Topo sort slices
    const slIn = new Map<string, number>();
    for (const s of activeMs.slices) slIn.set(s.id, 0);
    for (const s of activeMs.slices) {
      for (const dep of s.depends) {
        if (slMap.has(dep)) slIn.set(s.id, (slIn.get(s.id) ?? 0) + 1);
      }
    }

    const slQueue: string[] = [];
    for (const [id, d] of slIn) {
      if (d === 0) slQueue.push(id);
    }

    const slTopo: string[] = [];
    while (slQueue.length > 0) {
      const n = slQueue.shift()!;
      slTopo.push(n);
      for (const next of (slAdj.get(n) ?? [])) {
        const d = (slIn.get(next) ?? 1) - 1;
        slIn.set(next, d);
        if (d === 0) slQueue.push(next);
      }
    }

    const slDist = new Map<string, number>();
    const slPrev = new Map<string, string | null>();
    for (const s of activeMs.slices) {
      const w = s.done ? 0 : 1;
      slDist.set(s.id, 0);
      slPrev.set(s.id, null);
    }

    for (const n of slTopo) {
      const w = (slMap.get(n)?.done ? 0 : 1);
      const nd = slDist.get(n)! + w;
      for (const next of (slAdj.get(n) ?? [])) {
        if (nd > slDist.get(next)!) {
          slDist.set(next, nd);
          slPrev.set(next, n);
        }
      }
    }

    let slMax = 0;
    let slEnd = activeMs.slices[0].id;
    for (const s of activeMs.slices) {
      const totalDist = slDist.get(s.id)! + (s.done ? 0 : 1);
      if (totalDist > slMax) {
        slMax = totalDist;
        slEnd = s.id;
      }
    }

    let slCur: string | null = slEnd;
    while (slCur !== null) {
      slicePath.unshift(slCur);
      slCur = slPrev.get(slCur) ?? null;
    }

    const slCritSet = new Set(slicePath);
    for (const s of activeMs.slices) {
      if (slCritSet.has(s.id)) {
        sliceSlack.set(s.id, 0);
      } else {
        const nodeTotal = slDist.get(s.id)! + (s.done ? 0 : 1);
        sliceSlack.set(s.id, Math.max(0, slMax - nodeTotal));
      }
    }
  }

  return { milestonePath, slicePath, milestoneSlack, sliceSlack };
}

// ─── Agent Activity ──────────────────────────────────────────────────────────

function loadAgentActivity(units: UnitMetrics[], milestones: VisualizerMilestone[]): AgentActivityInfo | null {
  if (units.length === 0) return null;

  // Find currently running unit (finishedAt === 0)
  const running = units.find(u => u.finishedAt === 0);
  const now = Date.now();

  const completedUnits = units.filter(u => u.finishedAt > 0).length;
  const totalSlices = milestones.reduce((sum, m) => sum + m.slices.length, 0);

  // Completion rate from finished units
  const finished = units.filter(u => u.finishedAt > 0);
  let completionRate = 0;
  if (finished.length >= 2) {
    const earliest = Math.min(...finished.map(u => u.startedAt));
    const latest = Math.max(...finished.map(u => u.finishedAt));
    const totalHours = (latest - earliest) / 3_600_000;
    completionRate = totalHours > 0 ? finished.length / totalHours : 0;
  }

  const sessionCost = units.reduce((sum, u) => sum + u.cost, 0);
  const sessionTokens = units.reduce((sum, u) => sum + u.tokens.total, 0);

  return {
    currentUnit: running
      ? { type: running.type, id: running.id, startedAt: running.startedAt }
      : null,
    elapsed: running ? now - running.startedAt : 0,
    completedUnits,
    totalSlices,
    completionRate,
    active: !!running,
    sessionCost,
    sessionTokens,
  };
}

// ─── Changelog ───────────────────────────────────────────────────────────────

const changelogCache = new Map<string, { mtime: number; entry: ChangelogEntry }>();

async function loadChangelog(basePath: string, milestones: VisualizerMilestone[]): Promise<ChangelogInfo> {
  const entries: ChangelogEntry[] = [];

  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) continue;

      const summaryFile = resolveSliceFile(basePath, ms.id, sl.id, 'SUMMARY');
      if (!summaryFile) continue;

      // Check cache by file path
      const cacheKey = `${ms.id}/${sl.id}`;
      const cached = changelogCache.get(cacheKey);

      // Check mtime for cache invalidation
      let mtime = 0;
      try {
        const { statSync } = await import('node:fs');
        mtime = statSync(summaryFile).mtimeMs;
      } catch {
        continue;
      }

      if (cached && cached.mtime === mtime) {
        entries.push(cached.entry);
        continue;
      }

      const content = await loadFile(summaryFile);
      if (!content) continue;

      const summary = parseSummary(content);
      const entry: ChangelogEntry = {
        milestoneId: ms.id,
        sliceId: sl.id,
        title: sl.title,
        oneLiner: summary.oneLiner,
        filesModified: summary.filesModified.map(f => ({
          path: f.path,
          description: f.description,
        })),
        completedAt: summary.frontmatter.completed_at ?? '',
      };

      changelogCache.set(cacheKey, { mtime, entry });
      entries.push(entry);
    }
  }

  // Sort by completedAt descending
  entries.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  return { entries };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loadVisualizerData(basePath: string): Promise<VisualizerData> {
  const state = await deriveState(basePath);
  const milestoneIds = findMilestoneIds(basePath);

  const milestones: VisualizerMilestone[] = [];

  for (const mid of milestoneIds) {
    const entry = state.registry.find(r => r.id === mid);
    const status = entry?.status ?? 'pending';
    const dependsOn = entry?.dependsOn ?? [];

    const slices: VisualizerSlice[] = [];

    const roadmapFile = resolveMilestoneFile(basePath, mid, 'ROADMAP');
    const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;

    if (roadmapContent) {
      const roadmap = parseRoadmap(roadmapContent);

      for (const s of roadmap.slices) {
        const isActiveSlice =
          state.activeMilestone?.id === mid &&
          state.activeSlice?.id === s.id;

        const tasks: VisualizerTask[] = [];

        if (isActiveSlice) {
          const planFile = resolveSliceFile(basePath, mid, s.id, 'PLAN');
          const planContent = planFile ? await loadFile(planFile) : null;

          if (planContent) {
            const plan = parsePlan(planContent);
            for (const t of plan.tasks) {
              tasks.push({
                id: t.id,
                title: t.title,
                done: t.done,
                active: state.activeTask?.id === t.id,
              });
            }
          }
        }

        slices.push({
          id: s.id,
          title: s.title,
          done: s.done,
          active: isActiveSlice,
          risk: s.risk,
          depends: s.depends,
          tasks,
        });
      }
    }

    milestones.push({
      id: mid,
      title: entry?.title ?? mid,
      status,
      dependsOn,
      slices,
    });
  }

  // Metrics
  let totals: ProjectTotals | null = null;
  let byPhase: PhaseAggregate[] = [];
  let bySlice: SliceAggregate[] = [];
  let byModel: ModelAggregate[] = [];
  let units: UnitMetrics[] = [];

  const ledger = getLedger() ?? loadLedgerFromDisk(basePath);

  if (ledger && ledger.units.length > 0) {
    units = [...ledger.units].sort((a, b) => a.startedAt - b.startedAt);
    totals = getProjectTotals(units);
    byPhase = aggregateByPhase(units);
    bySlice = aggregateBySlice(units);
    byModel = aggregateByModel(units);
  }

  // Compute new fields
  const criticalPath = computeCriticalPath(milestones);

  let remainingSliceCount = 0;
  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) remainingSliceCount++;
    }
  }

  const agentActivity = loadAgentActivity(units, milestones);
  const changelog = await loadChangelog(basePath, milestones);

  return {
    milestones,
    phase: state.phase,
    totals,
    byPhase,
    bySlice,
    byModel,
    units,
    criticalPath,
    remainingSliceCount,
    agentActivity,
    changelog,
  };
}
