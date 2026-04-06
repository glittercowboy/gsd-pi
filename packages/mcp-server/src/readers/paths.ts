// GSD MCP Server — .gsd/ directory resolution
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the .gsd/ root directory for a project.
 *
 * Probes in order:
 *   1. projectDir/.gsd (fast path)
 *   2. git repo root/.gsd
 *   3. Walk up from projectDir
 *   4. Fallback: projectDir/.gsd (even if missing — for init)
 */
export function resolveGsdRoot(projectDir: string): string {
  const resolved = resolve(projectDir);

  // Fast path: .gsd/ in the given directory
  const direct = join(resolved, '.gsd');
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    return direct;
  }

  // Try git repo root
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolved,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const gitGsd = join(gitRoot, '.gsd');
    if (existsSync(gitGsd) && statSync(gitGsd).isDirectory()) {
      return gitGsd;
    }
  } catch {
    // Not a git repo or git not available
  }

  // Walk up from projectDir
  let dir = resolved;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, '.gsd');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    dir = dirname(dir);
  }

  // Fallback
  return direct;
}

/** Resolve path to a .gsd/ root file (STATE.md, KNOWLEDGE.md, etc.) */
export function resolveRootFile(gsdRoot: string, name: string): string {
  return join(gsdRoot, name);
}

/** Resolve path to milestones directory */
export function milestonesDir(gsdRoot: string): string {
  return join(gsdRoot, 'milestones');
}

/**
 * Find all milestone directory IDs (M001, M002, etc.).
 * Handles both bare (M001/) and descriptor (M001-FLIGHT-SIM/) naming.
 */
export function findMilestoneIds(gsdRoot: string): string[] {
  const dir = milestonesDir(gsdRoot);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const ids: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(M\d+)/);
    if (match) ids.push(match[1]);
  }

  return ids.sort();
}

/**
 * Resolve the actual directory name for a milestone ID.
 * M001 might live in M001/ or M001-SOME-DESCRIPTOR/.
 */
export function resolveMilestoneDir(gsdRoot: string, milestoneId: string): string | null {
  const dir = milestonesDir(gsdRoot);
  if (!existsSync(dir)) return null;

  // Fast path: exact match
  const exact = join(dir, milestoneId);
  if (existsSync(exact) && statSync(exact).isDirectory()) return exact;

  // Prefix match
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(milestoneId)) {
      return join(dir, entry.name);
    }
  }

  return null;
}

/**
 * Resolve a milestone-level file (M001-ROADMAP.md, M001-CONTEXT.md, etc.).
 * Handles various naming conventions.
 */
export function resolveMilestoneFile(gsdRoot: string, milestoneId: string, suffix: string): string | null {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return null;

  const dirName = basename(mDir);

  // Try: M001-ROADMAP.md, then DIRNAME-ROADMAP.md
  const candidates = [
    join(mDir, `${milestoneId}-${suffix}.md`),
    join(mDir, `${dirName}-${suffix}.md`),
    join(mDir, `${suffix}.md`),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Find all slice IDs within a milestone (S01, S02, etc.) */
export function findSliceIds(gsdRoot: string, milestoneId: string): string[] {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return [];

  const slicesDir = join(mDir, 'slices');
  if (!existsSync(slicesDir)) return [];

  const entries = readdirSync(slicesDir, { withFileTypes: true });
  const ids: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(S\d+)/);
    if (match) ids.push(match[1]);
  }

  return ids.sort();
}

/** Resolve the actual directory for a slice */
export function resolveSliceDir(gsdRoot: string, milestoneId: string, sliceId: string): string | null {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return null;

  const slicesDir = join(mDir, 'slices');
  if (!existsSync(slicesDir)) return null;

  const exact = join(slicesDir, sliceId);
  if (existsSync(exact) && statSync(exact).isDirectory()) return exact;

  const entries = readdirSync(slicesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(sliceId)) {
      return join(slicesDir, entry.name);
    }
  }
  return null;
}

/** Resolve a slice-level file (S01-PLAN.md, etc.) */
export function resolveSliceFile(
  gsdRoot: string, milestoneId: string, sliceId: string, suffix: string,
): string | null {
  const sDir = resolveSliceDir(gsdRoot, milestoneId, sliceId);
  if (!sDir) return null;

  const dirName = basename(sDir);
  const candidates = [
    join(sDir, `${sliceId}-${suffix}.md`),
    join(sDir, `${dirName}-${suffix}.md`),
    join(sDir, `${suffix}.md`),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Find all task files in a slice's tasks/ directory */
export function findTaskFiles(
  gsdRoot: string, milestoneId: string, sliceId: string,
): Array<{ id: string; hasPlan: boolean; hasSummary: boolean }> {
  const sDir = resolveSliceDir(gsdRoot, milestoneId, sliceId);
  if (!sDir) return [];

  const tasksDir = join(sDir, 'tasks');
  if (!existsSync(tasksDir)) return [];

  const files = readdirSync(tasksDir);
  const taskMap = new Map<string, { hasPlan: boolean; hasSummary: boolean }>();

  for (const f of files) {
    const match = f.match(/^(T\d+).*-(PLAN|SUMMARY)\.md$/i);
    if (!match) continue;
    const [, id, type] = match;
    const existing = taskMap.get(id) ?? { hasPlan: false, hasSummary: false };
    if (type.toUpperCase() === 'PLAN') existing.hasPlan = true;
    if (type.toUpperCase() === 'SUMMARY') existing.hasSummary = true;
    taskMap.set(id, existing);
  }

  return Array.from(taskMap.entries())
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
