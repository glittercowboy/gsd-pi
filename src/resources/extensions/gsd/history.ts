// GSD Extension — Session History View
// Human-readable display of past auto-mode unit executions.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import {
  getLedger, getProjectTotals, formatCost, formatTokenCount,
  aggregateBySlice, aggregateByPhase, aggregateByModel, loadLedgerFromDisk,
} from "./metrics.js";
import type { UnitMetrics } from "./metrics.js";

/**
 * Show recent unit execution history with cost, tokens, and duration.
 */
export async function handleHistory(args: string, ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const ledger = getLedger();

  // If ledger is null (metrics not initialized from auto-mode), try loading from disk
  let units: UnitMetrics[];
  if (ledger && ledger.units.length > 0) {
    units = ledger.units;
  } else {
    const diskLedger = loadLedgerFromDisk(basePath);
    if (!diskLedger || diskLedger.units.length === 0) {
      ctx.ui.notify("No history — no units have been executed yet.", "info");
      return;
    }
    units = diskLedger.units;
  }

  const parsedLimit = parseInt(args.replace(/--\w+/g, "").trim(), 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
  const showCost = args.includes("--cost");
  const showPhase = args.includes("--phase");
  const showModel = args.includes("--model");

  if (showCost) {
    return showCostBreakdown(units, ctx);
  }
  if (showPhase) {
    return showPhaseBreakdown(units, ctx);
  }
  if (showModel) {
    return showModelBreakdown(units, ctx);
  }

  const display = units.slice(-limit).reverse();
  const totals = getProjectTotals(units);

  const lines: string[] = [
    `Last ${display.length} of ${units.length} units | Total: ${formatCost(totals.cost)} · ${formatTokenCount(totals.tokens.total)} tokens`,
    "",
    padRight("Time", 14) + padRight("Type", 20) + padRight("ID", 16) + padRight("Model", 14) + padRight("Cost", 10) + padRight("Tokens", 10) + "Duration",
    "─".repeat(98),
  ];

  for (const u of display) {
    lines.push(
      padRight(formatRelativeTime(u.finishedAt), 14) +
      padRight(u.type, 20) +
      padRight(truncate(u.id, 15), 16) +
      padRight(shortModel(u.model), 14) +
      padRight(formatCost(u.cost), 10) +
      padRight(formatTokenCount(u.tokens.total), 10) +
      formatDuration(u.finishedAt - u.startedAt),
    );
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function showCostBreakdown(units: UnitMetrics[], ctx: ExtensionCommandContext): void {
  const slices = aggregateBySlice(units);
  const lines = [
    "Cost by slice:",
    "",
    padRight("Slice", 16) + padRight("Units", 8) + padRight("Cost", 10) + "Tokens",
    "─".repeat(50),
  ];
  for (const s of slices) {
    lines.push(
      padRight(s.sliceId, 16) +
      padRight(String(s.units), 8) +
      padRight(formatCost(s.cost), 10) +
      formatTokenCount(s.tokens.total),
    );
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function showPhaseBreakdown(units: UnitMetrics[], ctx: ExtensionCommandContext): void {
  const phases = aggregateByPhase(units);
  const lines = [
    "Cost by phase:",
    "",
    padRight("Phase", 16) + padRight("Units", 8) + padRight("Cost", 10) + padRight("Tokens", 10) + "Duration",
    "─".repeat(60),
  ];
  for (const p of phases) {
    lines.push(
      padRight(p.phase, 16) +
      padRight(String(p.units), 8) +
      padRight(formatCost(p.cost), 10) +
      padRight(formatTokenCount(p.tokens.total), 10) +
      formatDuration(p.duration),
    );
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function showModelBreakdown(units: UnitMetrics[], ctx: ExtensionCommandContext): void {
  const models = aggregateByModel(units);
  const lines = [
    "Cost by model:",
    "",
    padRight("Model", 24) + padRight("Units", 8) + padRight("Cost", 10) + "Tokens",
    "─".repeat(56),
  ];
  for (const m of models) {
    lines.push(
      padRight(shortModel(m.model), 24) +
      padRight(String(m.units), 8) +
      padRight(formatCost(m.cost), 10) +
      formatTokenCount(m.tokens.total),
    );
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/^anthropic\//, "");
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}
