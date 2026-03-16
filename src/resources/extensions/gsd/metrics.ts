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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { gsdRoot } from "./paths.js";
import { getAndClearSkills } from "./skill-telemetry.js";

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
  tokens: TokenCounts;
  cost: number;            // total USD cost
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  promptCharCount?: number;
  baselineCharCount?: number;
  tier?: string;           // complexity tier (light/standard/heavy) if dynamic routing active
  modelDowngraded?: boolean; // true if dynamic routing used a cheaper model
  skills?: string[];       // skill names available/loaded during this unit (#599)
}

export interface MetricsLedger {
  version: 1;
  projectStartedAt: number;
  units: UnitMetrics[];
}

// ─── Phase classification ─────────────────────────────────────────────────────

export type MetricsPhase = "research" | "planning" | "execution" | "completion" | "reassessment";

export function classifyUnitPhase(unitType: string): MetricsPhase {
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      return "research";
    case "plan-milestone":
    case "plan-slice":
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
  opts?: { promptCharCount?: number; baselineCharCount?: number; tier?: string; modelDowngraded?: boolean },
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
          if (block.type === "tool_call") toolCalls++;
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
    tokens,
    cost,
    toolCalls,
    assistantMessages,
    userMessages,
    ...(opts?.promptCharCount != null ? { promptCharCount: opts.promptCharCount } : {}),
    ...(opts?.baselineCharCount != null ? { baselineCharCount: opts.baselineCharCount } : {}),
    ...(opts?.tier ? { tier: opts.tier } : {}),
    ...(opts?.modelDowngraded !== undefined ? { modelDowngraded: opts.modelDowngraded } : {}),
  };

  // Auto-capture skill telemetry (#599)
  const skills = getAndClearSkills();
  if (skills.length > 0) {
    unit.skills = skills;
  }

  ledger.units.push(unit);
  saveLedger(basePath, ledger);

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
}

export interface ProjectTotals {
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
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
  const order: MetricsPhase[] = ["research", "planning", "execution", "completion", "reassessment"];
  return order.map(p => map.get(p)).filter((a): a is PhaseAggregate => !!a);
}

export function aggregateBySlice(units: UnitMetrics[]): SliceAggregate[] {
  const map = new Map<string, SliceAggregate>();
  for (const u of units) {
    const parts = u.id.split("/");
    // Slice ID is parts[0]/parts[1] if it exists, else parts[0]
    const sliceId = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
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
  };
  for (const u of units) {
    totals.tokens = addTokens(totals.tokens, u.tokens);
    totals.cost += u.cost;
    totals.duration += u.finishedAt - u.startedAt;
    totals.toolCalls += u.toolCalls;
    totals.assistantMessages += u.assistantMessages;
    totals.userMessages += u.userMessages;
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

export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

// ─── Disk I/O ─────────────────────────────────────────────────────────────────

function metricsPath(base: string): string {
  return join(gsdRoot(base), "metrics.json");
}

/**
 * Load ledger from disk without initializing in-memory state.
 * Used by history/export commands outside of auto-mode.
 */
export function loadLedgerFromDisk(base: string): MetricsLedger | null {
  try {
    const raw = readFileSync(metricsPath(base), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === 1 && Array.isArray(parsed.units)) {
      return parsed as MetricsLedger;
    }
  } catch {
    // File doesn't exist or is corrupt
  }
  return null;
}

function loadLedger(base: string): MetricsLedger {
  try {
    const raw = readFileSync(metricsPath(base), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === 1 && Array.isArray(parsed.units)) {
      return parsed as MetricsLedger;
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return {
    version: 1,
    projectStartedAt: Date.now(),
    units: [],
  };
}

function saveLedger(base: string, data: MetricsLedger): void {
  try {
    mkdirSync(gsdRoot(base), { recursive: true });
    writeFileSync(metricsPath(base), JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // Don't let metrics failures break auto-mode
  }
}
