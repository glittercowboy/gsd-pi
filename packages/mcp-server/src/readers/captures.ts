// GSD MCP Server — captures reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import { resolveGsdRoot, resolveRootFile } from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptureStatus = 'pending' | 'triaged' | 'resolved';
export type CaptureClassification =
  | 'quick-task' | 'inject' | 'defer' | 'replan' | 'note' | 'stop' | 'backtrack';

export interface CaptureEntry {
  id: string;
  text: string;
  timestamp: string;
  status: CaptureStatus;
  classification: CaptureClassification | null;
  resolution: string | null;
  rationale: string | null;
  resolvedAt: string | null;
  milestone: string | null;
  executed: string | null;
}

export interface CapturesResult {
  captures: CaptureEntry[];
  counts: {
    total: number;
    pending: number;
    resolved: number;
    actionable: number;
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseCapturesMarkdown(content: string): CaptureEntry[] {
  const entries: CaptureEntry[] = [];

  // Split on H3 headers: ### CAP-xxxxxxxx
  const sections = content.split(/(?=^### CAP-)/m);

  for (const section of sections) {
    const idMatch = section.match(/^### (CAP-[\da-f]+)/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const field = (label: string): string | null => {
      const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
      const m = section.match(re);
      return m ? m[1].trim() : null;
    };

    const status = (field('Status') ?? 'pending').toLowerCase() as CaptureStatus;
    const classification = field('Classification') as CaptureClassification | null;

    entries.push({
      id,
      text: field('Text') ?? '',
      timestamp: field('Captured') ?? '',
      status,
      classification,
      resolution: field('Resolution'),
      rationale: field('Rationale'),
      resolvedAt: field('Resolved'),
      milestone: field('Milestone'),
      executed: field('Executed'),
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ACTIONABLE_CLASSIFICATIONS = new Set<string>(['quick-task', 'inject', 'replan']);

export function readCaptures(
  projectDir: string,
  filter: 'all' | 'pending' | 'actionable' = 'all',
): CapturesResult {
  const gsd = resolveGsdRoot(projectDir);
  const capturesPath = resolveRootFile(gsd, 'CAPTURES.md');

  if (!existsSync(capturesPath)) {
    return { captures: [], counts: { total: 0, pending: 0, resolved: 0, actionable: 0 } };
  }

  const content = readFileSync(capturesPath, 'utf-8');
  let captures = parseCapturesMarkdown(content);

  // Compute counts before filtering
  const counts = {
    total: captures.length,
    pending: captures.filter((c) => c.status === 'pending').length,
    resolved: captures.filter((c) => c.status === 'resolved').length,
    actionable: captures.filter(
      (c) => c.classification !== null && ACTIONABLE_CLASSIFICATIONS.has(c.classification),
    ).length,
  };

  // Apply filter
  if (filter === 'pending') {
    captures = captures.filter((c) => c.status === 'pending');
  } else if (filter === 'actionable') {
    captures = captures.filter(
      (c) => c.classification !== null && ACTIONABLE_CLASSIFICATIONS.has(c.classification),
    );
  }

  return { captures, counts };
}
