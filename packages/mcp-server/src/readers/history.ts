/**
 * gsd_history — execution history from metrics.json.
 */

import { join } from 'node:path';
import { gsdDir, readFileSafe } from './shared.js';

interface HistoryEntry {
  id: string;
  type: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  tokens: { input: number; output: number; total: number };
  cost: number;
  toolCalls: number;
}

interface HistoryResult {
  totalUnits: number;
  totalCost: number;
  totalTokens: number;
  entries: HistoryEntry[];
}

export async function readHistory(
  projectDir: string,
  limit = 50,
): Promise<HistoryResult> {
  const base = gsdDir(projectDir);
  const raw = await readFileSafe(join(base, 'metrics.json'));
  if (!raw) return { totalUnits: 0, totalCost: 0, totalTokens: 0, entries: [] };

  let data: { units?: unknown[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return { totalUnits: 0, totalCost: 0, totalTokens: 0, entries: [] };
  }

  const units = Array.isArray(data.units) ? data.units : [];
  let totalCost = 0;
  let totalTokens = 0;

  const entries: HistoryEntry[] = [];
  for (const u of units) {
    const unit = u as Record<string, unknown>;
    const tokens = (unit.tokens as Record<string, number>) ?? {};
    const cost = (unit.cost as number) ?? 0;
    totalCost += cost;
    totalTokens += (tokens.total as number) ?? 0;

    entries.push({
      id: (unit.id as string) ?? 'unknown',
      type: (unit.type as string) ?? 'unknown',
      model: (unit.model as string) ?? 'unknown',
      startedAt: new Date((unit.startedAt as number) ?? 0).toISOString(),
      finishedAt: new Date((unit.finishedAt as number) ?? 0).toISOString(),
      tokens: {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        total: tokens.total ?? 0,
      },
      cost,
      toolCalls: (unit.toolCalls as number) ?? 0,
    });
  }

  // Return most recent entries up to limit
  const sliced = entries.slice(-limit);

  return {
    totalUnits: units.length,
    totalCost: Math.round(totalCost * 100) / 100,
    totalTokens,
    entries: sliced,
  };
}
