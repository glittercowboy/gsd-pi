/**
 * GSD Metrics — Token & Cost Tracking
 *
 * Accumulates per-unit usage data across auto-mode sessions.
 * Data is extracted from session entries before each context wipe,
 * written to .gsd/metrics.json, and surfaced in the dashboard.
 *
 * Data flow:
 *   1. Before newSession() wipes context, snapshotUnitMetrics() scans
 *      session entries for AssistantMessage usage data
 *   2. The unit record is appended to the in-memory ledger and flushed to disk
 *   3. The dashboard overlay and progress widget read from the in-memory ledger
 *   4. On crash recovery or fresh start, the ledger is loaded from disk
 */

import { join } from "node:path";
import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { gsdRoot } from "./paths.js";
import { getAndClearSkills } from "./skill-telemetry.js";
import { loadJsonFile, loadJsonFileOrNull, saveJsonFile } from "./json-persistence.js";
import { parseUnitId } from "./unit-id.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./uok/audit.js";
import { isUnifiedAuditEnabled } from "./uok/audit-toggle.js";

// Re-export from shared — import directly from format-utils to avoid pulling
// in the full barrel (mod.js → ui.js → @gsd/pi-tui) which breaks when loaded
// outside jiti's alias resolution (e.g. dynamic import in auto-loop reports).
export { formatTokenCount } from "../shared/format-utils.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UnitMetrics {
  type: string;            // e.g. "research-milestone", "execute-task"
  id: string;              // e.g. "M001/S01/T01"
  model: string;           // model ID used
  startedAt: number;       // ms timestamp
  finishedAt: number;      // ms timestamp
  autoSessionKey?: string; // identifies one auto-mode run across pause/resume
  tokens: TokenCounts;
  cost: number;            // total USD cost
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  apiRequests?: number;    // total API requests made (useful for copilot users where cost is always 0)
  // Budget fields (optional — absent in pre-M009 metrics data)
  contextWindowTokens?: number;
  truncationSections?: number;
  continueHereFired?: boolean;
  promptCharCount?: number;
  baselineCharCount?: number;
  tier?: string;           // complexity tier (light/standard/heavy) if dynamic routing active
  modelDowngraded?: boolean; // true if dynamic routing used a cheaper model
  skills?: string[];       // skill names available/loaded during this unit (#599)
  cacheHitRate?: number;       // percentage 0-100, computed from cacheRead/(cacheRead+input)
  compressionSavings?: number; // percentage 0-100, char savings from prompt compression
}

/** Budget state passed to snapshotUnitMetrics for persistence in the metrics ledger. */
export interface BudgetInfo {
  contextWindowTokens?: number;
  truncationSections?: number;
  continueHereFired?: boolean;
}

export interface MetricsLedger {
  version: 1;
  projectStartedAt: number;
  units: UnitMetrics[];
}

// ─── Phase classification ─────────────────────────────────────────────────────

export type MetricsPhase = "research" | "discussion" | "planning" | "execution" | "completion" | "reassessment";

export function classifyUnitPhase(unitType: string): MetricsPhase {
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      return "research";
    case "discuss-milestone":
    case "discuss-slice":
      return "discussion";
    case "plan-milestone":
    case "plan-slice":
    case "refine-slice":
      return "planning";
    case "execute-task":
      return "execution";
    case "complete-slice":
      return "completion";
    case "reassess-roadmap":
      return "reassessment";
    default:
      return "execution";
  }
}

// ─── In-memory state ──────────────────────────────────────────────────────────

let ledger: MetricsLedger | null = null;
let basePath: string = "";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the metrics system for a given project.
 * Loads existing ledger from disk if present.
 */
export function initMetrics(base: string): void {
  basePath = base;
  ledger = loadLedger(base);
}

/**
 * Reset in-memory state. Called when auto-mode stops.
 */
export function resetMetrics(): void {
  ledger = null;
  basePath = "";
}

/**
 * Snapshot usage metrics from the current session before it's wiped.
 * Scans session entries for AssistantMessage usage data.
 */
export function snapshotUnitMetrics(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  startedAt: number,
  model: string,
  opts?: {
    tier?: string;
    modelDowngraded?: boolean;
    contextWindowTokens?: number;
    truncationSections?: number;
    continueHereFired?: boolean;
    promptCharCount?: number;
    baselineCharCount?: number;
    autoSessionKey?: string;
    traceId?: string;
    turnId?: string;
    causedBy?: string;
  },
): UnitMetrics | null {
  if (!ledger) return null;

  const entries = ctx.sessionManager.getEntries();
  if (!entries || entries.length === 0) return null;

  const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let toolCalls = 0;
  let assistantMessages = 0;
  let userMessages = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg) continue;

    if (msg.role === "assistant") {
      assistantMessages++;
      if (msg.usage) {
        tokens.input += msg.usage.input ?? 0;
        tokens.output += msg.usage.output ?? 0;
        tokens.cacheRead += msg.usage.cacheRead ?? 0;
        tokens.cacheWrite += msg.usage.cacheWrite ?? 0;
        tokens.total += msg.usage.totalTokens ?? 0;
        if (msg.usage.cost != null) {
          const c = msg.usage.cost;
          cost += typeof c === "number" ? c : (c.total ?? 0);
        }
      }
      // Count tool calls in this message
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall") toolCalls++;
        }
      }
    } else if (msg.role === "user") {
      userMessages++;
    }
  }

  const unit: UnitMetrics = {
    type: unitType,
    id: unitId,
    model,
    startedAt,
    finishedAt: Date.now(),
    ...(opts?.autoSessionKey ? { autoSessionKey: opts.autoSessionKey } : {}),
    tokens,
    cost,
    toolCalls,
    assistantMessages,
    userMessages,
    apiRequests: assistantMessages, // each assistant message = one API request
    ...(opts?.tier ? { tier: opts.tier } : {}),
    ...(opts?.modelDowngraded !== undefined ? { modelDowngraded: opts.modelDowngraded } : {}),
    ...(opts?.contextWindowTokens !== undefined ? { contextWindowTokens: opts.contextWindowTokens } : {}),
    ...(opts?.truncationSections !== undefined ? { truncationSections: opts.truncationSections } : {}),
    ...(opts?.continueHereFired !== undefined ? { continueHereFired: opts.continueHereFired } : {}),
    ...(opts?.promptCharCount != null ? { promptCharCount: opts.promptCharCount } : {}),
    ...(opts?.baselineCharCount != null ? { baselineCharCount: opts.baselineCharCount } : {}),
  };

  // Auto-capture skill telemetry (#599)
  const skills = getAndClearSkills();
  if (skills.length > 0) {
    unit.skills = skills;
  }

  // Compute cache hit rate
  if (tokens.cacheRead > 0 || tokens.input > 0) {
    const totalInput = tokens.cacheRead + tokens.input;
    unit.cacheHitRate = totalInput > 0 ? Math.round((tokens.cacheRead / totalInput) * 100) : 0;
  }

  // ── Idempotency guard ──────────────────────────────────────────────────
  // Prevent duplicate metrics entries when multiple callers snapshot the
  // same unit (e.g. idle-watchdog closeoutUnit + normal loop closeoutUnit).
  // A unit is considered a duplicate when type, id, AND startedAt all match
  // an existing entry. On duplicate, the existing entry is updated in-place
  // with the latest finishedAt and token counts instead of appending.
  const dupeIdx = ledger.units.findIndex(
    (u) => u.type === unit.type && u.id === unit.id && u.startedAt === unit.startedAt,
  );
  if (dupeIdx >= 0) {
    ledger.units[dupeIdx] = unit;
  } else {
    ledger.units.push(unit);
  }
  saveLedger(basePath, ledger);

  if (isUnifiedAuditEnabled()) {
    emitUokAuditEvent(
      basePath,
      buildAuditEnvelope({
        traceId: opts?.traceId ?? `metrics:${unitType}:${unitId}`,
        turnId: opts?.turnId,
        causedBy: opts?.causedBy,
        category: "metrics",
        type: "unit-metrics-snapshot",
        payload: {
          unitType,
          unitId,
          model,
          tokens: unit.tokens,
          cost: unit.cost,
          toolCalls: unit.toolCalls,
        },
      }),
    );
  }

  return unit;
}

/**
 * Get the current ledger (read-only).
 */
export function getLedger(): MetricsLedger | null {
  return ledger;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

export interface PhaseAggregate {
  phase: MetricsPhase;
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;  // ms
}

export interface SliceAggregate {
  sliceId: string;
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;
}

export interface ModelAggregate {
  model: string;
  units: number;
  tokens: TokenCounts;
  cost: number;
  contextWindowTokens?: number;
}

export interface ProjectTotals {
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  apiRequests: number;
  totalTruncationSections: number;
  continueHereFiredCount: number;
}

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

export function aggregateByPhase(units: UnitMetrics[]): PhaseAggregate[] {
  const map = new Map<MetricsPhase, PhaseAggregate>();
  for (const u of units) {
    const phase = classifyUnitPhase(u.type);
    let agg = map.get(phase);
    if (!agg) {
      agg = { phase, units: 0, tokens: emptyTokens(), cost: 0, duration: 0 };
      map.set(phase, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    agg.duration += u.finishedAt - u.startedAt;
  }
  // Return in a stable order
  const order: MetricsPhase[] = ["research", "discussion", "planning", "execution", "completion", "reassessment"];
  return order.map(p => map.get(p)).filter((a): a is PhaseAggregate => !!a);
}

export function aggregateBySlice(units: UnitMetrics[]): SliceAggregate[] {
  const map = new Map<string, SliceAggregate>();
  for (const u of units) {
    const { milestone, slice } = parseUnitId(u.id);
    const sliceId = slice ? `${milestone}/${slice}` : milestone;
    let agg = map.get(sliceId);
    if (!agg) {
      agg = { sliceId, units: 0, tokens: emptyTokens(), cost: 0, duration: 0 };
      map.set(sliceId, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    agg.duration += u.finishedAt - u.startedAt;
  }
  return Array.from(map.values()).sort((a, b) => a.sliceId.localeCompare(b.sliceId));
}

export function aggregateByModel(units: UnitMetrics[]): ModelAggregate[] {
  const map = new Map<string, ModelAggregate>();
  for (const u of units) {
    let agg = map.get(u.model);
    if (!agg) {
      agg = { model: u.model, units: 0, tokens: emptyTokens(), cost: 0 };
      map.set(u.model, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    if (u.contextWindowTokens !== undefined && agg.contextWindowTokens === undefined) {
      agg.contextWindowTokens = u.contextWindowTokens;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
}

export function getProjectTotals(units: UnitMetrics[]): ProjectTotals {
  const totals: ProjectTotals = {
    units: units.length,
    tokens: emptyTokens(),
    cost: 0,
    duration: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
    apiRequests: 0,
    totalTruncationSections: 0,
    continueHereFiredCount: 0,
  };
  for (const u of units) {
    totals.tokens = addTokens(totals.tokens, u.tokens);
    totals.cost += u.cost;
    totals.duration += u.finishedAt - u.startedAt;
    totals.toolCalls += u.toolCalls;
    totals.assistantMessages += u.assistantMessages;
    totals.userMessages += u.userMessages;
    totals.apiRequests += u.apiRequests ?? u.assistantMessages; // fallback for pre-existing data
    totals.totalTruncationSections += u.truncationSections ?? 0;
    if (u.continueHereFired) totals.continueHereFiredCount++;
  }
  return totals;
}

// ─── Tier Aggregation ────────────────────────────────────────────────────────

export interface TierAggregate {
  tier: string;
  units: number;
  tokens: TokenCounts;
  cost: number;
  downgraded: number;   // units that were downgraded by dynamic routing
}

export function aggregateByTier(units: UnitMetrics[]): TierAggregate[] {
  const map = new Map<string, TierAggregate>();
  for (const u of units) {
    const tier = u.tier ?? "unknown";
    let agg = map.get(tier);
    if (!agg) {
      agg = { tier, units: 0, tokens: emptyTokens(), cost: 0, downgraded: 0 };
      map.set(tier, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    if (u.modelDowngraded) agg.downgraded++;
  }
  const order = ["light", "standard", "heavy", "unknown"];
  return order.map(t => map.get(t)).filter((a): a is TierAggregate => !!a);
}

/**
 * Format a summary of savings from dynamic routing.
 * Returns empty string if no units were downgraded.
 */
export function formatTierSavings(units: UnitMetrics[]): string {
  const downgraded = units.filter(u => u.modelDowngraded);
  if (downgraded.length === 0) return "";

  const downgradedCost = downgraded.reduce((sum, u) => sum + u.cost, 0);
  const totalUnits = units.filter(u => u.tier).length;
  const pct = totalUnits > 0 ? Math.round((downgraded.length / totalUnits) * 100) : 0;

  return `Dynamic routing: ${downgraded.length}/${totalUnits} units downgraded (${pct}%), cost: ${formatCost(downgradedCost)}`;
}

/**
 * Compute aggregate cache hit rate across all units.
 * Returns percentage 0-100.
 */
export function aggregateCacheHitRate(): number {
  if (!ledger || ledger.units.length === 0) return 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  for (const unit of ledger.units) {
    totalInput += unit.tokens.input;
    totalCacheRead += unit.tokens.cacheRead;
  }
  const total = totalInput + totalCacheRead;
  return total > 0 ? Math.round((totalCacheRead / total) * 100) : 0;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatCost(cost: number): string {
  const n = Number(cost) || 0;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// ─── Budget Prediction ────────────────────────────────────────────────────────

/**
 * Calculate average cost per unit type from completed units.
 * Returns a Map from unit type to average cost in USD.
 */
export function getAverageCostPerUnitType(units: UnitMetrics[]): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const u of units) {
    const entry = sums.get(u.type) ?? { total: 0, count: 0 };
    entry.total += u.cost;
    entry.count += 1;
    sums.set(u.type, entry);
  }
  const avgs = new Map<string, number>();
  for (const [type, { total, count }] of sums) {
    avgs.set(type, total / count);
  }
  return avgs;
}

/**
 * Estimate remaining cost given average costs and remaining unit counts.
 * @param avgCosts - Average cost per unit type
 * @param remainingUnits - Array of unit types still to dispatch
 * @param fallbackAvg - Fallback average if unit type not seen before
 * @returns Estimated remaining cost in USD
 */
export function predictRemainingCost(
  avgCosts: Map<string, number>,
  remainingUnits: string[],
  fallbackAvg?: number,
): number {
  // If no averages available, use overall average as fallback
  const allAvgs = [...avgCosts.values()];
  const overallAvg = fallbackAvg ?? (allAvgs.length > 0 ? allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length : 0);

  let total = 0;
  for (const unitType of remainingUnits) {
    total += avgCosts.get(unitType) ?? overallAvg;
  }
  return total;
}

/**
 * Compute a projected remaining cost based on completed slice averages.
 *
 * Filters to slice-level entries (sliceId contains "/") to exclude bare milestone
 * aggregates from the average. Returns [] when fewer than 2 slice-level entries
 * exist (insufficient data for a reliable projection).
 *
 * If `budgetCeiling` is provided and `totalCost >= budgetCeiling`, a warning line
 * is appended to the result.
 */
export function formatCostProjection(
  completedSlices: SliceAggregate[],
  remainingCount: number,
  budgetCeiling?: number,
): string[] {
  const sliceLevel = completedSlices.filter(s => s.sliceId.includes("/"));
  if (sliceLevel.length < 2) return [];

  const totalCost = sliceLevel.reduce((sum, s) => sum + s.cost, 0);
  const avgCost = totalCost / sliceLevel.length;
  const projected = avgCost * remainingCount;

  const projLine = `Projected remaining: ${formatCost(projected)} (${formatCost(avgCost)}/slice avg × ${remainingCount} remaining)`;
  const result: string[] = [projLine];

  if (budgetCeiling !== undefined && totalCost >= budgetCeiling) {
    result.push(`Budget ceiling ${formatCost(budgetCeiling)} reached (spent ${formatCost(totalCost)})`);
  }

  return result;
}


// ─── Disk I/O ─────────────────────────────────────────────────────────────────

function metricsPath(base: string): string {
  return join(gsdRoot(base), "metrics.json");
}

function isMetricsLedger(data: unknown): data is MetricsLedger {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as MetricsLedger).version === 1 &&
    Array.isArray((data as MetricsLedger).units)
  );
}

function defaultLedger(): MetricsLedger {
  return { version: 1, projectStartedAt: Date.now(), units: [] };
}

/**
 * Prune the metrics ledger to at most `keepCount` most-recent unit entries.
 *
 * Called by the doctor when the ledger exceeds the bloat threshold.
 * Keeps the newest entries (highest index = most recent) and discards
 * the oldest from the head of the array. Preserves `projectStartedAt`.
 *
 * Updates both the on-disk file and the in-memory ledger if it is loaded,
 * so the current session sees the pruned state immediately.
 *
 * @returns the number of entries removed, or 0 if no pruning was needed.
 */
export function pruneMetricsLedger(base: string, keepCount: number): number {
  const disk = loadLedgerFromDisk(base);
  if (!disk || disk.units.length <= keepCount) return 0;
  const removed = disk.units.length - keepCount;
  disk.units = disk.units.slice(-keepCount);
  saveJsonFile(metricsPath(base), disk);
  // Keep the in-memory ledger in sync if it is loaded for this session.
  if (ledger) {
    ledger.units = ledger.units.slice(-keepCount);
  }
  return removed;
}

/**
 * Load ledger from disk without initializing in-memory state.
 * Used by history/export commands outside of auto-mode.
 */
export function loadLedgerFromDisk(base: string): MetricsLedger | null {
  return loadJsonFileOrNull(metricsPath(base), isMetricsLedger);
}

function loadLedger(base: string): MetricsLedger {
  const raw = loadJsonFile(metricsPath(base), isMetricsLedger, defaultLedger);
  const before = raw.units.length;
  raw.units = deduplicateUnits(raw.units);
  if (raw.units.length < before) {
    // Persist the cleaned ledger so duplicates don't re-accumulate
    saveLedger(base, raw);
  }
  return raw;
}

/**
 * Collapse duplicate entries with the same (type, id, startedAt) triple.
 * Keeps the entry with the highest finishedAt (the most complete snapshot).
 *
 * This is a defensive measure against idle-watchdog race conditions that can
 * produce duplicate entries on disk despite the in-memory idempotency guard
 * in snapshotUnitMetrics(). See #1943.
 */
function deduplicateUnits(units: UnitMetrics[]): UnitMetrics[] {
  const map = new Map<string, UnitMetrics>();
  for (const u of units) {
    const key = `${u.type}\0${u.id}\0${u.startedAt}`;
    const existing = map.get(key);
    if (!existing || u.finishedAt > existing.finishedAt) {
      map.set(key, u);
    }
  }
  return Array.from(map.values());
}

function saveLedger(base: string, data: MetricsLedger): void {
  saveJsonFile(metricsPath(base), data);
}
