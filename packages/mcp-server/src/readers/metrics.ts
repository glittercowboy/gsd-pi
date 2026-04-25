// GSD MCP Server — metrics/history reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import { resolveGsdRoot, resolveRootFile } from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsUnit {
  type: string;
  id: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  toolCalls: number;
  apiRequests: number;
}

export interface HistoryResult {
  entries: MetricsUnit[];
  totals: {
    cost: number;
    tokens: { input: number; output: number; total: number };
    units: number;
    durationMs: number;
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseMetricsJson(content: string): MetricsUnit[] {
  try {
    const data = JSON.parse(content);
    if (!data.units || !Array.isArray(data.units)) return [];

    return data.units.map((u: Record<string, unknown>) => ({
      type: String(u.type ?? 'unknown'),
      id: String(u.id ?? ''),
      model: String(u.model ?? 'unknown'),
      startedAt: Number(u.startedAt ?? 0),
      finishedAt: Number(u.finishedAt ?? 0),
      tokens: {
        input: Number((u.tokens as Record<string, unknown>)?.input ?? 0),
        output: Number((u.tokens as Record<string, unknown>)?.output ?? 0),
        cacheRead: Number((u.tokens as Record<string, unknown>)?.cacheRead ?? 0),
        cacheWrite: Number((u.tokens as Record<string, unknown>)?.cacheWrite ?? 0),
        total: Number((u.tokens as Record<string, unknown>)?.total ?? 0),
      },
      cost: Number(u.cost ?? 0),
      toolCalls: Number(u.toolCalls ?? 0),
      apiRequests: Number(u.apiRequests ?? 0),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readHistory(projectDir: string, limit?: number): HistoryResult {
  const gsd = resolveGsdRoot(projectDir);

  // metrics.json (primary)
  const metricsPath = resolveRootFile(gsd, 'metrics.json');
  let units: MetricsUnit[] = [];

  if (existsSync(metricsPath)) {
    const content = readFileSync(metricsPath, 'utf-8');
    units = parseMetricsJson(content);
  }

  // Sort by startedAt descending (most recent first)
  units.sort((a, b) => b.startedAt - a.startedAt);

  // Apply limit
  if (limit && limit > 0) {
    units = units.slice(0, limit);
  }

  // Compute totals from ALL units (not just limited set)
  const allUnits = existsSync(metricsPath)
    ? parseMetricsJson(readFileSync(metricsPath, 'utf-8'))
    : [];

  const totals = {
    cost: 0,
    tokens: { input: 0, output: 0, total: 0 },
    units: allUnits.length,
    durationMs: 0,
  };

  for (const u of allUnits) {
    totals.cost += u.cost;
    totals.tokens.input += u.tokens.input;
    totals.tokens.output += u.tokens.output;
    totals.tokens.total += u.tokens.total;
    totals.durationMs += (u.finishedAt - u.startedAt);
  }

  // Round cost to 4 decimal places
  totals.cost = Math.round(totals.cost * 10000) / 10000;

  return { entries: units, totals };
}
