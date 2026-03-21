// Data loader for workflow visualizer overlay — aggregates state + metrics.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deriveState } from './state.js';
import { parseRoadmap, parsePlan, parseSummary, loadFile } from './files.js';
import { findMilestoneIds } from './milestone-ids.js';
import { resolveMilestoneFile, resolveSliceFile, resolveGsdRootFile, gsdRoot } from './paths.js';
import {
  getLedger,
  getProjectTotals,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  aggregateByTier,
  formatTierSavings,
  loadLedgerFromDisk,
  classifyUnitPhase,
} from './metrics.js';
import { loadAllCaptures, countPendingCaptures } from './captures.js';
import { loadEffectiveGSDPreferences } from './preferences.js';
import { runProviderChecks, type ProviderCheckResult } from './doctor-providers.js';
import { generateSkillHealthReport } from './skill-health.js';
import { runEnvironmentChecks, type EnvironmentCheckResult } from './doctor-environment.js';
import { computeProgressScore } from './progress-score.js';
import { getHealthHistory } from './doctor-proactive.js';

import type { Phase } from './types.js';
import type { CaptureEntry } from './captures.js';
import type {
  ProjectTotals,
  PhaseAggregate,
  SliceAggregate,
  ModelAggregate,
  TierAggregate,
  UnitMetrics,
} from './metrics.js';

// ─── Visualizer Types ─────────────────────────────────────────────────────────

export interface VisualizerMilestone {
  id: string;
  title: string;
  status: 'complete' | 'active' | 'pending' | 'parked';
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
  estimate?: string;
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

export interface VisualizerSliceRef {
  milestoneId: string;
  sliceId: string;
  title: string;
}

export interface VisualizerSliceActivity extends VisualizerSliceRef {
  completedAt: string;
}

export interface VisualizerStats {
  missingCount: number;
  missingSlices: VisualizerSliceRef[];
  updatedCount: number;
  updatedSlices: VisualizerSliceActivity[];
  recentEntries: ChangelogEntry[];
}

export type DiscussionState = 'undiscussed' | 'draft' | 'discussed';

export interface VisualizerDiscussionState {
  milestoneId: string;
  title: string;
  state: DiscussionState;
  hasContext: boolean;
  hasDraft: boolean;
  lastUpdated: string | null;
}

export interface SliceVerification {
  milestoneId: string;
  sliceId: string;
  verificationResult: string;
  blockerDiscovered: boolean;
  keyDecisions: string[];
  patternsEstablished: string[];
  provides: string[];
  requires: { slice: string; provides: string }[];
}

export interface KnowledgeInfo {
  rules: { id: string; scope: string; content: string }[];
  patterns: { id: string; content: string }[];
  lessons: { id: string; content: string }[];
  exists: boolean;
}

export interface CapturesInfo {
  entries: CaptureEntry[];
  pendingCount: number;
  totalCount: number;
}

export interface ProviderStatusSummary {
  name: string;
  label: string;
  category: string;
  ok: boolean;
  required: boolean;
  message: string;
}

export interface SkillSummaryInfo {
  total: number;
  warningCount: number;
  criticalCount: number;
  topIssue: string | null;
}

/** A single doctor history entry for visualizer display. */
export interface VisualizerDoctorEntry {
  ts: string;
  ok: boolean;
  errors: number;
  warnings: number;
  fixes: number;
  codes: string[];
  issues?: Array<{ severity: string; code: string; message: string; unitId: string }>;
  fixDescriptions?: string[];
  scope?: string;
  summary?: string;
}

/** Current progress score snapshot for health display. */
export interface VisualizerProgressScore {
  level: "green" | "yellow" | "red";
  summary: string;
  signals: Array<{ kind: "positive" | "negative" | "neutral"; label: string }>;
}

export interface HealthInfo {
  budgetCeiling: number | undefined;
  tokenProfile: string;
  truncationRate: number;
  continueHereRate: number;
  tierBreakdown: TierAggregate[];
  tierSavingsLine: string;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  providers: ProviderStatusSummary[];
  skillSummary: SkillSummaryInfo;
  environmentIssues: import("./doctor-environment.js").EnvironmentCheckResult[];
  /** Persisted doctor run history (most recent first, up to 20 entries). */
  doctorHistory?: VisualizerDoctorEntry[];
  /** Current in-memory progress score (null if auto-mode not active). */
  progressScore?: VisualizerProgressScore | null;
}

export interface VisualizerData {
  milestones: VisualizerMilestone[];
  phase: Phase;
  totals: ProjectTotals | null;
  byPhase: PhaseAggregate[];
  bySlice: SliceAggregate[];
  byModel: ModelAggregate[];
  byTier: TierAggregate[];
  tierSavingsLine: string;
  units: UnitMetrics[];
  criticalPath: CriticalPathInfo;
  remainingSliceCount: number;
  agentActivity: AgentActivityInfo | null;
  changelog: ChangelogInfo;
  sliceVerifications: SliceVerification[];
  knowledge: KnowledgeInfo;
  captures: CapturesInfo;
  health: HealthInfo;
  discussion: VisualizerDiscussionState[];
  stats: VisualizerStats;
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

// ─── Changelog & Verifications ────────────────────────────────────────────────

const changelogCache = new Map<string, { mtime: number; entry: ChangelogEntry; verification: SliceVerification }>();

interface ChangelogAndVerifications {
  changelog: ChangelogInfo;
  verifications: SliceVerification[];
}

async function loadChangelogAndVerifications(basePath: string, milestones: VisualizerMilestone[]): Promise<ChangelogAndVerifications> {
  const entries: ChangelogEntry[] = [];
  const verifications: SliceVerification[] = [];

  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) continue;

      const summaryFile = resolveSliceFile(basePath, ms.id, sl.id, 'SUMMARY');
      if (!summaryFile) continue;

      const cacheKey = `${ms.id}/${sl.id}`;
      const cached = changelogCache.get(cacheKey);

      let mtime = 0;
      try {
        mtime = statSync(summaryFile).mtimeMs;
      } catch {
        continue;
      }

      if (cached && cached.mtime === mtime) {
        entries.push(cached.entry);
        verifications.push(cached.verification);
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
        completedAt: String(summary.frontmatter.completed_at ?? ''),
      };

      const verification: SliceVerification = {
        milestoneId: ms.id,
        sliceId: sl.id,
        verificationResult: summary.frontmatter.verification_result || '',
        blockerDiscovered: summary.frontmatter.blocker_discovered,
        keyDecisions: summary.frontmatter.key_decisions || [],
        patternsEstablished: summary.frontmatter.patterns_established || [],
        provides: summary.frontmatter.provides || [],
        requires: (summary.frontmatter.requires || []).map(r => ({
          slice: r.slice,
          provides: r.provides,
        })),
      };

      changelogCache.set(cacheKey, { mtime, entry, verification });
      entries.push(entry);
      verifications.push(verification);
    }
  }

  entries.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));

  return { changelog: { entries }, verifications };
}

// ─── Knowledge Loader ─────────────────────────────────────────────────────────

function loadKnowledge(basePath: string): KnowledgeInfo {
  const knowledgePath = resolveGsdRootFile(basePath, 'KNOWLEDGE');
  if (!existsSync(knowledgePath)) {
    return { rules: [], patterns: [], lessons: [], exists: false };
  }

  let content: string;
  try {
    content = readFileSync(knowledgePath, 'utf-8');
  } catch {
    return { rules: [], patterns: [], lessons: [], exists: false };
  }

  const rules: { id: string; scope: string; content: string }[] = [];
  const patterns: { id: string; content: string }[] = [];
  const lessons: { id: string; content: string }[] = [];

  const lines = content.split('\n');
  let currentSection = '';

  for (const line of lines) {
    if (line.startsWith('## Rules')) { currentSection = 'rules'; continue; }
    if (line.startsWith('## Patterns')) { currentSection = 'patterns'; continue; }
    if (line.startsWith('## Lessons')) { currentSection = 'lessons'; continue; }
    if (line.startsWith('## ')) { currentSection = ''; continue; }

    if (!line.startsWith('| ') || line.startsWith('| ---') || line.startsWith('| ID')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cols.length < 2) continue;

    if (currentSection === 'rules' && cols.length >= 3) {
      rules.push({ id: cols[0], scope: cols[1], content: cols[2] });
    } else if (currentSection === 'patterns' && cols.length >= 2) {
      patterns.push({ id: cols[0], content: cols[1] });
    } else if (currentSection === 'lessons' && cols.length >= 2) {
      lessons.push({ id: cols[0], content: cols[1] });
    }
  }

  return { rules, patterns, lessons, exists: true };
}

// ─── Health Loader ────────────────────────────────────────────────────────────

function loadHealth(units: UnitMetrics[], totals: ProjectTotals | null, basePath: string): HealthInfo {
  const prefs = loadEffectiveGSDPreferences();
  const budgetCeiling = prefs?.preferences?.budget_ceiling;
  const tokenProfile = prefs?.preferences?.token_profile ?? 'standard';

  let truncationRate = 0;
  let continueHereRate = 0;
  if (totals && totals.units > 0) {
    truncationRate = (totals.totalTruncationSections / totals.units) * 100;
    continueHereRate = (totals.continueHereFiredCount / totals.units) * 100;
  }

  const tierBreakdown = aggregateByTier(units);
  const tierSavingsLine = formatTierSavings(units);

  // Provider checks — fast (auth.json + env vars only, no network)
  let providers: ProviderStatusSummary[] = [];
  try {
    providers = runProviderChecks().map((r: ProviderCheckResult) => ({
      name: r.name,
      label: r.label,
      category: r.category,
      ok: r.status === "ok" || r.status === "unconfigured",
      required: r.required,
      message: r.message,
    }));
  } catch { /* non-fatal */ }

  // Skill health summary
  let skillSummary: SkillSummaryInfo = { total: 0, warningCount: 0, criticalCount: 0, topIssue: null };
  try {
    const report = generateSkillHealthReport(basePath);
    const warnings = report.suggestions.filter(s => s.severity === "warning");
    const criticals = report.suggestions.filter(s => s.severity === "critical");
    skillSummary = {
      total: report.skills.length,
      warningCount: warnings.length,
      criticalCount: criticals.length,
      topIssue: report.suggestions[0]?.message ?? null,
    };
  } catch { /* non-fatal */ }

  // Environment issues (from doctor-environment.ts, #1221)
  let environmentIssues: EnvironmentCheckResult[] = [];
  try {
    environmentIssues = runEnvironmentChecks(basePath).filter(r => r.status !== "ok");
  } catch { /* non-fatal */ }

  // Doctor run history — persisted across sessions (sync read to keep loadHealth sync)
  let doctorHistory: VisualizerDoctorEntry[] = [];
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    if (existsSync(historyPath)) {
      const lines = readFileSync(historyPath, "utf-8").split("\n").filter(l => l.trim());
      doctorHistory = lines.slice(-20).reverse().map(l => JSON.parse(l) as VisualizerDoctorEntry);
    }
  } catch { /* non-fatal */ }

  // Current progress score — only meaningful when auto-mode has health data
  let progressScore: VisualizerProgressScore | null = null;
  try {
    const history = getHealthHistory();
    if (history.length > 0) {
      const score = computeProgressScore();
      progressScore = { level: score.level, summary: score.summary, signals: score.signals };
    }
  } catch { /* non-fatal */ }

  return {
    budgetCeiling,
    tokenProfile,
    truncationRate,
    continueHereRate,
    tierBreakdown,
    tierSavingsLine,
    toolCalls: totals?.toolCalls ?? 0,
    assistantMessages: totals?.assistantMessages ?? 0,
    userMessages: totals?.userMessages ?? 0,
    providers,
    skillSummary,
    environmentIssues,
    doctorHistory,
    progressScore,
  };
}

const RECENT_ENTRY_LIMIT = 3;
const FEATURE_PREVIEW_LIMIT = 5;
const UPDATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function buildVisualizerStats(
  milestones: VisualizerMilestone[],
  entries: ChangelogEntry[],
): VisualizerStats {
  const missing: VisualizerSliceRef[] = [];
  for (const ms of milestones) {
    for (const sl of ms.slices) {
      if (!sl.done) missing.push({ milestoneId: ms.id, sliceId: sl.id, title: sl.title });
    }
  }

  const missingCount = missing.length;
  const missingSlices = missing.slice(0, FEATURE_PREVIEW_LIMIT);

  const now = Date.now();
  const updatedEntries = entries.filter(entry => {
    if (!entry.completedAt) return false;
    const parsed = Date.parse(entry.completedAt);
    return !Number.isNaN(parsed) && now - parsed <= UPDATED_WINDOW_MS;
  });
  const updatedCount = updatedEntries.length;
  const updatedSlices = updatedEntries.slice(0, FEATURE_PREVIEW_LIMIT).map(entry => ({
    milestoneId: entry.milestoneId,
    sliceId: entry.sliceId,
    title: entry.title,
    completedAt: entry.completedAt,
  }));

  const recentEntries = entries.slice(0, RECENT_ENTRY_LIMIT);

  return {
    missingCount,
    missingSlices,
    updatedCount,
    updatedSlices,
    recentEntries,
  };
}

function loadDiscussionState(
  basePath: string,
  milestones: VisualizerMilestone[],
): VisualizerDiscussionState[] {
  const states: VisualizerDiscussionState[] = [];

  for (const ms of milestones) {
    const contextPath = resolveMilestoneFile(basePath, ms.id, "CONTEXT");
    const draftPath = resolveMilestoneFile(basePath, ms.id, "CONTEXT-DRAFT");
    const state: DiscussionState = contextPath
      ? "discussed"
      : draftPath
        ? "draft"
        : "undiscussed";

    let lastUpdated: string | null = null;
    const target = contextPath ?? draftPath;
    if (target) {
      try {
        lastUpdated = new Date(statSync(target).mtimeMs).toISOString();
      } catch {
        lastUpdated = null;
      }
    }

    states.push({
      milestoneId: ms.id,
      title: ms.title,
      state,
      hasContext: !!contextPath,
      hasDraft: !!draftPath,
      lastUpdated,
    });
  }

  return states;
}

// ─── File Fingerprint Cache ───────────────────────────────────────────────────

/**
 * Mtime-based cache for parsed file contents. Avoids re-reading and re-parsing
 * roadmap/plan files whose mtime hasn't changed since the last load.
 */
const fileContentCache = new Map<string, { mtime: number; content: string }>();

function readFileCached(filePath: string): string | null {
  try {
    const mtime = statSync(filePath).mtimeMs;
    const cached = fileContentCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return cached.content;
    }
    const content = readFileSync(filePath, 'utf-8');
    fileContentCache.set(filePath, { mtime, content });
    return content;
  } catch {
    return null;
  }
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
    const roadmapContent = roadmapFile ? readFileCached(roadmapFile) : null;

    if (roadmapContent) {
      const roadmap = parseRoadmap(roadmapContent);

      for (const s of roadmap.slices) {
        const isActiveSlice =
          state.activeMilestone?.id === mid &&
          state.activeSlice?.id === s.id;

        const tasks: VisualizerTask[] = [];

        if (isActiveSlice) {
          const planFile = resolveSliceFile(basePath, mid, s.id, 'PLAN');
          const planContent = planFile ? readFileCached(planFile) : null;

          if (planContent) {
            const plan = parsePlan(planContent);
            for (const t of plan.tasks) {
              tasks.push({
                id: t.id,
                title: t.title,
                done: t.done,
                active: state.activeTask?.id === t.id,
                estimate: t.estimate || undefined,
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
  let byTier: TierAggregate[] = [];
  let tierSavingsLine = '';
  let units: UnitMetrics[] = [];

  const ledger = getLedger() ?? loadLedgerFromDisk(basePath);

  if (ledger && ledger.units.length > 0) {
    units = [...ledger.units].sort((a, b) => a.startedAt - b.startedAt);
    totals = getProjectTotals(units);
    byPhase = aggregateByPhase(units);
    bySlice = aggregateBySlice(units);
    byModel = aggregateByModel(units);
    byTier = aggregateByTier(units);
    tierSavingsLine = formatTierSavings(units);
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
  const { changelog, verifications: sliceVerifications } = await loadChangelogAndVerifications(basePath, milestones);

  const knowledge = loadKnowledge(basePath);
  const allCaptures = loadAllCaptures(basePath);
  const pendingCount = countPendingCaptures(basePath);
  const captures: CapturesInfo = {
    entries: allCaptures,
    pendingCount,
    totalCount: allCaptures.length,
  };

  const health = loadHealth(units, totals, basePath);
  const stats = buildVisualizerStats(milestones, changelog.entries);
  const discussion = loadDiscussionState(basePath, milestones);

  return {
    milestones,
    phase: state.phase,
    totals,
    byPhase,
    bySlice,
    byModel,
    byTier,
    tierSavingsLine,
    units,
    criticalPath,
    remainingSliceCount,
    agentActivity,
    changelog,
    sliceVerifications,
    knowledge,
    captures,
    health,
    discussion,
    stats,
  };
}
