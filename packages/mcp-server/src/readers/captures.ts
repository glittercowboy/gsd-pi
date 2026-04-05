/**
 * gsd_captures — pending ideas/captures with filtering.
 */

import { join } from 'node:path';
import { gsdDir, readFileSafe } from './shared.js';

interface CaptureEntry {
  id: string;
  text: string;
  status: 'pending' | 'resolved' | 'executed';
  timestamp?: string;
}

interface CapturesResult {
  total: number;
  pending: number;
  entries: CaptureEntry[];
}

export async function readCaptures(
  projectDir: string,
  filter: 'all' | 'pending' | 'actionable' = 'all',
): Promise<CapturesResult> {
  const base = gsdDir(projectDir);
  const content = await readFileSafe(join(base, 'CAPTURES.md'));
  if (!content) return { total: 0, pending: 0, entries: [] };

  const entries: CaptureEntry[] = [];

  // Parse capture entries: - [ ] text or - [x] text with optional (id) prefix
  const lineRegex = /^- \[([ x~])\]\s*(?:\((\w+)\)\s*)?(.+)$/gm;
  let match;
  while ((match = lineRegex.exec(content)) !== null) {
    const marker = match[1];
    const id = match[2] || `c${entries.length + 1}`;
    const text = match[3].trim();

    let status: CaptureEntry['status'];
    if (marker === 'x') status = 'executed';
    else if (marker === '~') status = 'resolved';
    else status = 'pending';

    entries.push({ id, text, status });
  }

  const pending = entries.filter(e => e.status === 'pending').length;

  let filtered = entries;
  if (filter === 'pending') {
    filtered = entries.filter(e => e.status === 'pending');
  } else if (filter === 'actionable') {
    filtered = entries.filter(e => e.status !== 'executed');
  }

  return { total: entries.length, pending, entries: filtered };
}
