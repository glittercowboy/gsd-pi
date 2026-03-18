// GSD Extension - File Parsing and I/O
// Parsers for roadmap, plan, summary, and continue files.
// Used by state derivation and the status widget.
// Pure functions, zero Pi dependencies - uses only Node built-ins.

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteAsync } from './atomic-write.js';
import { resolveMilestoneFile, relMilestoneFile, resolveGsdRootFile } from './paths.js';
import { milestoneIdSort, findMilestoneIds } from './guided-flow.js';

import type {
  Roadmap, BoundaryMapEntry,
  SlicePlan, TaskPlanEntry,
  Summary, SummaryFrontmatter, SummaryRequires, FileModified,
  Continue, ContinueFrontmatter, ContinueStatus,
  RequirementCounts,
  SecretsManifest, SecretsManifestEntry, SecretsManifestEntryStatus,
  ManifestStatus,
} from './types.js';

import { checkExistingEnvKeys } from '../get-secrets-from-user.js';
import { parseRoadmapSlices } from './roadmap-slices.js';
import { nativeParseRoadmap, nativeExtractSection, nativeParsePlanFile, nativeParseSummaryFile, NATIVE_UNAVAILABLE } from './native-parser-bridge.js';
import { debugTime, debugCount } from './debug-logger.js';
import { CACHE_MAX } from './constants.js';
import { splitFrontmatter, parseFrontmatterMap } from '../shared/frontmatter.js';

// Re-export for downstream consumers
export { splitFrontmatter, parseFrontmatterMap };

// ─── Parse Cache ──────────────────────────────────────────────────────────

/** Fast composite key: length + first/mid/last 100 chars. The middle sample
 *  prevents collisions when only a few characters change in the interior of
 *  a file (e.g., a checkbox [ ] → [x] that doesn't alter length or endpoints). */
function cacheKey(content: string): string {
  const len = content.length;
  const head = content.slice(0, 100);
  const midStart = Math.max(0, Math.floor(len / 2) - 50);
  const mid = len > 200 ? content.slice(midStart, midStart + 100) : '';
  const tail = len > 100 ? content.slice(-100) : '';
  return `${len}:${head}:${mid}:${tail}`;
}

const _parseCache = new Map<string, unknown>();

function cachedParse<T>(content: string, tag: string, parseFn: (c: string) => T): T {
  const key = tag + '|' + cacheKey(content);
  if (_parseCache.has(key)) return _parseCache.get(key) as T;
  if (_parseCache.size >= CACHE_MAX) _parseCache.clear();
  const result = parseFn(content);
  _parseCache.set(key, result);
  return result;
}

/** Clear the module-scoped parse cache. Call when files change on disk. */
export function clearParseCache(): void {
  _parseCache.clear();
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Extract the text after a heading at a given level, up to the next heading of same or higher level. */
export function extractSection(body: string, heading: string, level: number = 2): string | null {
  // Try native parser first for better performance on large files
  const nativeResult = nativeExtractSection(body, heading, level);
  if (nativeResult !== NATIVE_UNAVAILABLE) return nativeResult as string | null;

  const prefix = '#'.repeat(level) + ' ';
  const regex = new RegExp(`^${prefix}${escapeRegex(heading)}\\s*$`, 'm');
  const match = regex.exec(body);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = body.slice(start);

  const nextHeading = rest.match(new RegExp(`^#{1,${level}} `, 'm'));
  const end = nextHeading ? nextHeading.index! : rest.length;

  return rest.slice(0, end).trim();
}

/** Extract all sections at a given level, returning heading → content map. */
export function extractAllSections(body: string, level: number = 2): Map<string, string> {
  const prefix = '#'.repeat(level) + ' ';
  const regex = new RegExp(`^${prefix}(.+)$`, 'gm');
  const sections = new Map<string, string>();
  const matches = [...body.matchAll(regex)];

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    sections.set(heading, body.slice(start, end).trim());
  }

  return sections;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse bullet list items from a text block. */
export function parseBullets(text: string): string[] {
  return text.split('\n')
    .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

/** Extract key: value from bold-prefixed lines like "**Key:** Value" */
export function extractBoldField(text: string, key: string): string | null {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, 'm');
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}

// ─── Roadmap Parser ────────────────────────────────────────────────────────

export function parseRoadmap(content: string): Roadmap {
  return cachedParse(content, 'roadmap', _parseRoadmapImpl);
}

function _parseRoadmapImpl(content: string): Roadmap {
  const stopTimer = debugTime("parse-roadmap");
  // Try native parser first for better performance
  const nativeResult = nativeParseRoadmap(content);
  if (nativeResult) {
    stopTimer({ native: true, slices: nativeResult.slices.length, boundaryEntries: nativeResult.boundaryMap.length });
    debugCount("parseRoadmapCalls");
    return nativeResult;
  }

  const lines = content.split('\n');

  const h1 = lines.find(l => l.startsWith('# '));
  const title = h1 ? h1.slice(2).trim() : '';
  const vision = extractBoldField(content, 'Vision') || '';

  const scSection = extractSection(content, 'Success Criteria', 2) ||
    (() => {
      const idx = content.indexOf('**Success Criteria:**');
      if (idx === -1) return '';
      const rest = content.slice(idx);
      const nextSection = rest.indexOf('\n---');
      const block = rest.slice(0, nextSection === -1 ? undefined : nextSection);
      const firstNewline = block.indexOf('\n');
      return firstNewline === -1 ? '' : block.slice(firstNewline + 1);
    })();
  const successCriteria = scSection ? parseBullets(scSection) : [];

  // Slices
  const slices = parseRoadmapSlices(content);

  // Boundary map
  const boundaryMap: BoundaryMapEntry[] = [];
  const bmSection = extractSection(content, 'Boundary Map');

  if (bmSection) {
    const h3Sections = extractAllSections(bmSection, 3);
    for (const [heading, sectionContent] of h3Sections) {
      const arrowMatch = heading.match(/^(\S+)\s*→\s*(\S+)/);
      if (!arrowMatch) continue;

      const fromSlice = arrowMatch[1];
      const toSlice = arrowMatch[2];

      let produces = '';
      let consumes = '';

      // Use indexOf-based parsing instead of [\s\S]*? regex to avoid
      // catastrophic backtracking on content with code fences (#468).
      const prodIdx = sectionContent.search(/^Produces:\s*$/m);
      if (prodIdx !== -1) {
        const afterProd = sectionContent.indexOf('\n', prodIdx);
        if (afterProd !== -1) {
          const consIdx = sectionContent.search(/^Consumes/m);
          const endIdx = consIdx !== -1 && consIdx > afterProd ? consIdx : sectionContent.length;
          produces = sectionContent.slice(afterProd + 1, endIdx).trim();
        }
      }

      const consLineMatch = sectionContent.match(/^Consumes[^:]*:\s*(.+)$/m);
      if (consLineMatch) {
        consumes = consLineMatch[1].trim();
      }
      if (!consumes) {
        const consIdx = sectionContent.search(/^Consumes[^:]*:\s*$/m);
        if (consIdx !== -1) {
          const afterCons = sectionContent.indexOf('\n', consIdx);
          if (afterCons !== -1) {
            consumes = sectionContent.slice(afterCons + 1).trim();
          }
        }
      }

      boundaryMap.push({ fromSlice, toSlice, produces, consumes });
    }
  }

  const result = { title, vision, successCriteria, slices, boundaryMap };
  stopTimer({ native: false, slices: slices.length, boundaryEntries: boundaryMap.length });
  debugCount("parseRoadmapCalls");
  return result;
}

// ─── Secrets Manifest Parser ───────────────────────────────────────────────

const VALID_STATUSES = new Set<SecretsManifestEntryStatus>(['pending', 'collected', 'skipped']);

export function parseSecretsManifest(content: string): SecretsManifest {
  const milestone = extractBoldField(content, 'Milestone') || '';
  const generatedAt = extractBoldField(content, 'Generated') || '';

  const h3Sections = extractAllSections(content, 3);
  const entries: SecretsManifestEntry[] = [];

  for (const [heading, sectionContent] of h3Sections) {
    const key = heading.trim();
    if (!key) continue;

    const service = extractBoldField(sectionContent, 'Service') || '';
    const dashboardUrl = extractBoldField(sectionContent, 'Dashboard') || '';
    const formatHint = extractBoldField(sectionContent, 'Format hint') || '';
    const rawStatus = (extractBoldField(sectionContent, 'Status') || 'pending').toLowerCase().trim() as SecretsManifestEntryStatus;
    const status: SecretsManifestEntryStatus = VALID_STATUSES.has(rawStatus) ? rawStatus : 'pending';
    const destination = extractBoldField(sectionContent, 'Destination') || 'dotenv';

    // Extract numbered guidance list (lines matching "1. ...", "2. ...", etc.)
    const guidance: string[] = [];
    for (const line of sectionContent.split('\n')) {
      const numMatch = line.match(/^\s*\d+\.\s+(.+)/);
      if (numMatch) {
        guidance.push(numMatch[1].trim());
      }
    }

    entries.push({ key, service, dashboardUrl, guidance, formatHint, status, destination });
  }

  return { milestone, generatedAt, entries };
}

// ─── Secrets Manifest Formatter ───────────────────────────────────────────

export function formatSecretsManifest(manifest: SecretsManifest): string {
  const lines: string[] = [];

  lines.push('# Secrets Manifest');
  lines.push('');
  lines.push(`**Milestone:** ${manifest.milestone}`);
  lines.push(`**Generated:** ${manifest.generatedAt}`);

  for (const entry of manifest.entries) {
    lines.push('');
    lines.push(`### ${entry.key}`);
    lines.push('');
    lines.push(`**Service:** ${entry.service}`);
    if (entry.dashboardUrl) {
      lines.push(`**Dashboard:** ${entry.dashboardUrl}`);
    }
    if (entry.formatHint) {
      lines.push(`**Format hint:** ${entry.formatHint}`);
    }
    lines.push(`**Status:** ${entry.status}`);
    lines.push(`**Destination:** ${entry.destination}`);
    lines.push('');
    for (let i = 0; i < entry.guidance.length; i++) {
      lines.push(`${i + 1}. ${entry.guidance[i]}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ─── Slice Plan Parser ─────────────────────────────────────────────────────

export function parsePlan(content: string): SlicePlan {
  return cachedParse(content, 'plan', _parsePlanImpl);
}

function _parsePlanImpl(content: string): SlicePlan {
  const stopTimer = debugTime("parse-plan");
  // Try native parser first for better performance
  const nativeResult = nativeParsePlanFile(content);
  if (nativeResult) {
    stopTimer({ native: true });
    return {
      id: nativeResult.id,
      title: nativeResult.title,
      goal: nativeResult.goal,
      demo: nativeResult.demo,
      mustHaves: nativeResult.mustHaves,
      tasks: nativeResult.tasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        done: t.done,
        estimate: t.estimate,
        ...(t.files.length > 0 ? { files: t.files } : {}),
        ...(t.verify ? { verify: t.verify } : {}),
      })),
      filesLikelyTouched: nativeResult.filesLikelyTouched,
    };
  }

  const lines = content.split('\n');

  const h1 = lines.find(l => l.startsWith('# '));
  let id = '';
  let title = '';
  if (h1) {
    const match = h1.match(/^#\s+(\w+):\s+(.+)/);
    if (match) {
      id = match[1];
      title = match[2].trim();
    } else {
      title = h1.slice(2).trim();
    }
  }

  const goal = extractBoldField(content, 'Goal') || '';
  const demo = extractBoldField(content, 'Demo') || '';

  const mhSection = extractSection(content, 'Must-Haves');
  const mustHaves = mhSection ? parseBullets(mhSection) : [];

  const tasksSection = extractSection(content, 'Tasks');
  const tasks: TaskPlanEntry[] = [];

  if (tasksSection) {
    const taskLines = tasksSection.split('\n');
    let currentTask: TaskPlanEntry | null = null;

    for (const line of taskLines) {
      const cbMatch = line.match(/^-\s+\[([ xX])\]\s+\*\*([\w.]+):\s+(.+?)\*\*\s*(.*)/);
      if (cbMatch) {
        if (currentTask) tasks.push(currentTask);

        const rest = cbMatch[4] || '';
        const estMatch = rest.match(/`est:([^`]+)`/);
        const estimate = estMatch ? estMatch[1] : '';

        currentTask = {
          id: cbMatch[2],
          title: cbMatch[3],
          description: '',
          done: cbMatch[1].toLowerCase() === 'x',
          estimate,
        };
      } else if (currentTask && line.match(/^\s*-\s+Files:\s*(.*)/)) {
        const filesMatch = line.match(/^\s*-\s+Files:\s*(.*)/);
        if (filesMatch) {
          currentTask.files = filesMatch[1]
            .split(',')
            .map(f => f.replace(/`/g, '').trim())
            .filter(f => f.length > 0);
        }
      } else if (currentTask && line.match(/^\s*-\s+Verify:\s*(.*)/)) {
        const verifyMatch = line.match(/^\s*-\s+Verify:\s*(.*)/);
        if (verifyMatch) {
          currentTask.verify = verifyMatch[1].trim();
        }
      } else if (currentTask && line.trim() && !line.startsWith('#')) {
        const desc = line.trim();
        if (desc) {
          currentTask.description = currentTask.description
            ? currentTask.description + ' ' + desc
            : desc;
        }
      }
    }
    if (currentTask) tasks.push(currentTask);
  }

  const filesSection = extractSection(content, 'Files Likely Touched');
  const filesLikelyTouched = filesSection ? parseBullets(filesSection) : [];

  const result = { id, title, goal, demo, mustHaves, tasks, filesLikelyTouched };
  stopTimer({ tasks: tasks.length });
  debugCount("parsePlanCalls");
  return result;
}

// ─── Summary Parser ────────────────────────────────────────────────────────

export function parseSummary(content: string): Summary {
  return cachedParse(content, 'summary', _parseSummaryImpl);
}

function _parseSummaryImpl(content: string): Summary {
  // Try native parser first for better performance
  const nativeResult = nativeParseSummaryFile(content);
  if (nativeResult) {
    const nfm = nativeResult.frontmatter;
    return {
      frontmatter: {
        id: nfm.id,
        parent: nfm.parent,
        milestone: nfm.milestone,
        provides: nfm.provides,
        requires: nfm.requires,
        affects: nfm.affects,
        key_files: nfm.keyFiles,
        key_decisions: nfm.keyDecisions,
        patterns_established: nfm.patternsEstablished,
        drill_down_paths: nfm.drillDownPaths,
        observability_surfaces: nfm.observabilitySurfaces,
        duration: nfm.duration,
        verification_result: nfm.verificationResult,
        completed_at: nfm.completedAt,
        blocker_discovered: nfm.blockerDiscovered,
      },
      title: nativeResult.title,
      oneLiner: nativeResult.oneLiner,
      whatHappened: nativeResult.whatHappened,
      deviations: nativeResult.deviations,
      filesModified: nativeResult.filesModified,
    };
  }

  const [fmLines, body] = splitFrontmatter(content);

  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
  const frontmatter: SummaryFrontmatter = {
    id: (fm.id as string) || '',
    parent: (fm.parent as string) || '',
    milestone: (fm.milestone as string) || '',
    provides: asStringArray(fm.provides),
    requires: ((fm.requires as Array<Record<string, string>>) || []).map(r => ({
      slice: r.slice || '',
      provides: r.provides || '',
    })),
    affects: asStringArray(fm.affects),
    key_files: asStringArray(fm.key_files),
    key_decisions: asStringArray(fm.key_decisions),
    patterns_established: asStringArray(fm.patterns_established),
    drill_down_paths: asStringArray(fm.drill_down_paths),
    observability_surfaces: asStringArray(fm.observability_surfaces),
    duration: (fm.duration as string) || '',
    verification_result: (fm.verification_result as string) || 'untested',
    completed_at: (fm.completed_at as string) || '',
    blocker_discovered: fm.blocker_discovered === 'true' || fm.blocker_discovered === true,
  };

  const bodyLines = body.split('\n');
  const h1 = bodyLines.find(l => l.startsWith('# '));
  const title = h1 ? h1.slice(2).trim() : '';

  const h1Idx = bodyLines.indexOf(h1 || '');
  let oneLiner = '';
  for (let i = h1Idx + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    if (!line) continue;
    if (line.startsWith('**') && line.endsWith('**')) {
      oneLiner = line.slice(2, -2);
    }
    break;
  }

  const whatHappened = extractSection(body, 'What Happened') || '';
  const deviations = extractSection(body, 'Deviations') || '';

  const filesSection = extractSection(body, 'Files Created/Modified') || extractSection(body, 'Files Modified');
  const filesModified: FileModified[] = [];
  if (filesSection) {
    for (const line of filesSection.split('\n')) {
      const trimmed = line.replace(/^\s*[-*]\s+/, '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const fileMatch = trimmed.match(/^`([^`]+)`\s*[—–-]\s*(.+)/);
      if (fileMatch) {
        filesModified.push({ path: fileMatch[1], description: fileMatch[2].trim() });
      }
    }
  }

  return { frontmatter, title, oneLiner, whatHappened, deviations, filesModified };
}

// ─── Continue Parser ───────────────────────────────────────────────────────

export function parseContinue(content: string): Continue {
  return cachedParse(content, 'continue', _parseContinueImpl);
}

function _parseContinueImpl(content: string): Continue {
  const [fmLines, body] = splitFrontmatter(content);

  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const frontmatter: ContinueFrontmatter = {
    milestone: (fm.milestone as string) || '',
    slice: (fm.slice as string) || '',
    task: (fm.task as string) || '',
    step: typeof fm.step === 'string' ? parseInt(fm.step) : (fm.step as number) || 0,
    totalSteps: typeof fm.total_steps === 'string' ? parseInt(fm.total_steps) : (fm.total_steps as number) ||
      (typeof fm.totalSteps === 'string' ? parseInt(fm.totalSteps) : (fm.totalSteps as number) || 0),
    status: ((fm.status as string) || 'in_progress') as ContinueStatus,
    savedAt: (fm.saved_at as string) || (fm.savedAt as string) || '',
  };

  const completedWork = extractSection(body, 'Completed Work') || '';
  const remainingWork = extractSection(body, 'Remaining Work') || '';
  const decisions = extractSection(body, 'Decisions Made') || '';
  const context = extractSection(body, 'Context') || '';
  const nextAction = extractSection(body, 'Next Action') || '';

  return { frontmatter, completedWork, remainingWork, decisions, context, nextAction };
}

// ─── Continue Formatter ────────────────────────────────────────────────────

function formatFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (typeof value[0] === 'object' && value[0] !== null) {
        lines.push(`${key}:`);
        for (const obj of value) {
          const entries = Object.entries(obj as Record<string, unknown>);
          if (entries.length > 0) {
            lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`);
            for (let i = 1; i < entries.length; i++) {
              lines.push(`    ${entries[i][0]}: ${entries[i][1]}`);
            }
          }
        }
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

export function formatContinue(cont: Continue): string {
  const fm = cont.frontmatter;
  const fmData: Record<string, unknown> = {
    milestone: fm.milestone,
    slice: fm.slice,
    task: fm.task,
    step: fm.step,
    total_steps: fm.totalSteps,
    status: fm.status,
    saved_at: fm.savedAt,
  };

  const lines: string[] = [];
  lines.push(formatFrontmatter(fmData));
  lines.push('');
  lines.push('## Completed Work');
  lines.push(cont.completedWork);
  lines.push('');
  lines.push('## Remaining Work');
  lines.push(cont.remainingWork);
  lines.push('');
  lines.push('## Decisions Made');
  lines.push(cont.decisions);
  lines.push('');
  lines.push('## Context');
  lines.push(cont.context);
  lines.push('');
  lines.push('## Next Action');
  lines.push(cont.nextAction);

  return lines.join('\n');
}

// ─── File I/O ──────────────────────────────────────────────────────────────

/**
 * Load a file from disk. Returns content string or null if file doesn't exist.
 */
export async function loadFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Save content to a file atomically (write to temp, then rename).
 * Creates parent directories if needed.
 */
export async function saveFile(path: string, content: string): Promise<void> {
  await atomicWriteAsync(path, content);
}

export function parseRequirementCounts(content: string | null): RequirementCounts {
  const counts: RequirementCounts = {
    active: 0,
    validated: 0,
    deferred: 0,
    outOfScope: 0,
    blocked: 0,
    total: 0,
  };

  if (!content) return counts;

  const sections = [
    { key: 'active', heading: 'Active' },
    { key: 'validated', heading: 'Validated' },
    { key: 'deferred', heading: 'Deferred' },
    { key: 'outOfScope', heading: 'Out of Scope' },
  ] as const;

  for (const section of sections) {
    const text = extractSection(content, section.heading, 2);
    if (!text) continue;
    const matches = text.match(/^###\s+[A-Z][\w-]*\d+\s+—/gm);
    counts[section.key] = matches ? matches.length : 0;
  }

  const blockedMatches = content.match(/^-\s+Status:\s+blocked\s*$/gim);
  counts.blocked = blockedMatches ? blockedMatches.length : 0;
  counts.total = counts.active + counts.validated + counts.deferred + counts.outOfScope;
  return counts;
}

// ─── Task Plan Must-Haves Parser ───────────────────────────────────────────

/**
 * Parse must-have items from a task plan's `## Must-Haves` section.
 * Returns structured items with checkbox state. Handles YAML frontmatter,
 * all common checkbox variants (`[ ]`, `[x]`, `[X]`), plain bullets (no checkbox),
 * and indented variants. Returns empty array when the section is missing or empty.
 */
export function parseTaskPlanMustHaves(content: string): Array<{ text: string; checked: boolean }> {
  const [, body] = splitFrontmatter(content);
  const sectionText = extractSection(body, 'Must-Haves');
  if (!sectionText) return [];

  const bullets = parseBullets(sectionText);
  if (bullets.length === 0) return [];

  return bullets.map(line => {
    const cbMatch = line.match(/^\[([xX ])\]\s+(.+)/);
    if (cbMatch) {
      return {
        text: cbMatch[2].trim(),
        checked: cbMatch[1].toLowerCase() === 'x',
      };
    }
    // No checkbox - treat as unchecked with full line as text
    return { text: line.trim(), checked: false };
  });
}

// ─── Must-Have Summary Matching ────────────────────────────────────────────

/** Common short words to exclude from substring matching. */
const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'its', 'let', 'say', 'she', 'too', 'use',
  'with', 'have', 'from', 'this', 'that', 'they', 'been', 'each', 'when', 'will',
  'does', 'into', 'also', 'than', 'them', 'then', 'some', 'what', 'only', 'just',
  'more', 'make', 'like', 'made', 'over', 'such', 'take', 'most', 'very', 'must',
  'file', 'test', 'tests', 'task', 'new', 'add', 'added', 'existing',
]);

/**
 * Count how many must-have items are mentioned in a summary.
 *
 * Matching heuristic per must-have:
 * 1. Extract all backtick-enclosed code tokens (e.g. `inspectFoo`).
 *    If any code token appears case-insensitively in the summary, count as mentioned.
 * 2. If no code tokens exist, check if any significant word (≥4 chars, not a common word)
 *    from the must-have text appears in the summary (case-insensitive).
 *
 * Returns the count of must-haves that had at least one match.
 */
export function countMustHavesMentionedInSummary(
  mustHaves: Array<{ text: string; checked: boolean }>,
  summaryContent: string,
): number {
  if (!summaryContent || mustHaves.length === 0) return 0;

  const summaryLower = summaryContent.toLowerCase();
  let count = 0;

  for (const mh of mustHaves) {
    // Extract backtick-enclosed code tokens
    const codeTokens: string[] = [];
    const codeRegex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = codeRegex.exec(mh.text)) !== null) {
      codeTokens.push(match[1]);
    }

    if (codeTokens.length > 0) {
      // Strategy 1: any code token found in summary (case-insensitive)
      const found = codeTokens.some(token => summaryLower.includes(token.toLowerCase()));
      if (found) count++;
    } else {
      // Strategy 2: significant substring matching
      // Split into words, keep words ≥4 chars that aren't common
      const words = mh.text.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w =>
        w.length >= 4 && !COMMON_WORDS.has(w.toLowerCase())
      );
      const found = words.some(word => summaryLower.includes(word.toLowerCase()));
      if (found) count++;
    }
  }

  return count;
}

// ─── UAT Type Extractor ────────────────────────────────────────────────────

/**
 * The four UAT classification types recognised by GSD auto-mode.
 * `undefined` is returned (not this union) when no type can be determined.
 */
export type UatType = 'artifact-driven' | 'live-runtime' | 'human-experience' | 'mixed';

/**
 * Extract the UAT type from a UAT file's raw content.
 *
 * UAT files have no YAML frontmatter - pass raw file content directly.
 * Classification is leading-keyword-only: e.g. `mixed (artifact-driven + live-runtime)` → `'mixed'`.
 *
 * Returns `undefined` when:
 * - the `## UAT Type` section is absent
 * - no `UAT mode:` bullet is found in the section
 * - the value does not start with a recognised keyword
 */
export function extractUatType(content: string): UatType | undefined {
  const sectionText = extractSection(content, 'UAT Type');
  if (!sectionText) return undefined;

  const bullets = parseBullets(sectionText);
  const modeBullet = bullets.find(b => b.startsWith('UAT mode:'));
  if (!modeBullet) return undefined;

  const rawValue = modeBullet.slice('UAT mode:'.length).trim().toLowerCase();

  if (rawValue.startsWith('artifact-driven')) return 'artifact-driven';
  if (rawValue.startsWith('live-runtime')) return 'live-runtime';
  if (rawValue.startsWith('human-experience')) return 'human-experience';
  if (rawValue.startsWith('mixed')) return 'mixed';

  return undefined;
}

/**
 * Extract the `depends_on` list from M00x-CONTEXT.md YAML frontmatter.
 * Returns [] when: content is null, no frontmatter block, field absent, or field is empty.
 * Normalizes each dep ID to uppercase (e.g. 'm001' → 'M001').
 */
export function parseContextDependsOn(content: string | null): string[] {
  if (!content) return [];
  const [fmLines] = splitFrontmatter(content);
  if (!fmLines) return [];
  const fm = parseFrontmatterMap(fmLines);
  const raw = fm['depends_on'];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return (raw as string[]).map(s => String(s).trim()).filter(Boolean);
}

/**
 * Inline the prior milestone's SUMMARY.md as context for the current milestone's planning prompt.
 * Returns null when: (1) `mid` is the first milestone, (2) prior milestone has no SUMMARY file.
 *
 * Uses the shared findMilestoneIds to scan the milestones directory.
 */
export async function inlinePriorMilestoneSummary(mid: string, base: string): Promise<string | null> {
  const sorted = findMilestoneIds(base);
  if (sorted.length === 0) return null;
  const idx = sorted.indexOf(mid);
  if (idx <= 0) return null;
  const prevMid = sorted[idx - 1];
  const absPath = resolveMilestoneFile(base, prevMid, "SUMMARY");
  const relPath = relMilestoneFile(base, prevMid, "SUMMARY");
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### Prior Milestone Summary\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

// ─── Manifest Status ──────────────────────────────────────────────────────

/**
 * Read a secrets manifest from disk and cross-reference each entry's status
 * with the current environment (.env + process.env).
 *
 * Returns `null` when no manifest file exists (path resolution failure or
 * file not on disk) - callers can distinguish "no manifest" from "empty manifest".
 */
export async function getManifestStatus(
  base: string, milestoneId: string,
): Promise<ManifestStatus | null> {
  const resolvedPath = resolveMilestoneFile(base, milestoneId, 'SECRETS');
  if (!resolvedPath) return null;

  const content = await loadFile(resolvedPath);
  if (!content) return null;

  const manifest = parseSecretsManifest(content);
  const keys = manifest.entries.map(e => e.key);
  const existingKeys = await checkExistingEnvKeys(keys, resolve(base, '.env'));
  const existingSet = new Set(existingKeys);

  const result: ManifestStatus = {
    pending: [],
    collected: [],
    skipped: [],
    existing: [],
  };

  for (const entry of manifest.entries) {
    if (existingSet.has(entry.key)) {
      result.existing.push(entry.key);
    } else {
      result[entry.status].push(entry.key);
    }
  }

  return result;
}

// ─── Overrides ──────────────────────────────────────────────────────────────

export interface Override {
  timestamp: string;
  change: string;
  scope: "active" | "resolved";
  appliedAt: string;
}

export async function appendOverride(basePath: string, change: string, appliedAt: string): Promise<void> {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const timestamp = new Date().toISOString();
  const entry = [
    `## Override: ${timestamp}`,
    "",
    `**Change:** ${change}`,
    `**Scope:** active`,
    `**Applied-at:** ${appliedAt}`,
    "",
    "---",
    "",
  ].join("\n");

  const existing = await loadFile(overridesPath);
  if (existing) {
    await saveFile(overridesPath, existing.trimEnd() + "\n\n" + entry);
  } else {
    const header = [
      "# GSD Overrides",
      "",
      "User-issued overrides that supersede plan document content.",
      "",
      "---",
      "",
    ].join("\n");
    await saveFile(overridesPath, header + entry);
  }
}

export async function appendKnowledge(
  basePath: string,
  type: "rule" | "pattern" | "lesson",
  entry: string,
  scope: string,
): Promise<void> {
  const knowledgePath = resolveGsdRootFile(basePath, "KNOWLEDGE");
  const existing = await loadFile(knowledgePath);

  if (existing) {
    // Find the next ID for this type
    const prefix = type === "rule" ? "K" : type === "pattern" ? "P" : "L";
    const idPattern = new RegExp(`^\\| ${prefix}(\\d+)`, "gm");
    let maxId = 0;
    let match;
    while ((match = idPattern.exec(existing)) !== null) {
      const num = parseInt(match[1], 10);
      if (num > maxId) maxId = num;
    }
    const nextId = `${prefix}${String(maxId + 1).padStart(3, "0")}`;

    // Build the table row
    let row: string;
    if (type === "rule") {
      row = `| ${nextId} | ${scope} | ${entry} | — | manual |`;
    } else if (type === "pattern") {
      row = `| ${nextId} | ${entry} | — | ${scope} |`;
    } else {
      row = `| ${nextId} | ${entry} | — | — | ${scope} |`;
    }

    // Find the right section and append after the table header
    const sectionHeading = type === "rule" ? "## Rules" : type === "pattern" ? "## Patterns" : "## Lessons Learned";
    const sectionIdx = existing.indexOf(sectionHeading);
    if (sectionIdx !== -1) {
      // Find the end of the table header row (the |---|...| line)
      const afterHeading = existing.indexOf("\n", sectionIdx);
      // Find the next section or end
      const nextSection = existing.indexOf("\n## ", afterHeading + 1);
      const insertPoint = nextSection !== -1 ? nextSection : existing.length;

      // Insert row before the next section (or at end)
      const before = existing.slice(0, insertPoint).trimEnd();
      const after = existing.slice(insertPoint);
      await saveFile(knowledgePath, before + "\n" + row + "\n" + after);
    } else {
      // Section not found — append at end
      await saveFile(knowledgePath, existing.trimEnd() + "\n\n" + row + "\n");
    }
  } else {
    // Create file from scratch with template header
    const header = [
      "# Project Knowledge",
      "",
      "Append-only register of project-specific rules, patterns, and lessons learned.",
      "Agents read this before every unit. Add entries when you discover something worth remembering.",
      "",
    ].join("\n");

    let content: string;
    if (type === "rule") {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        `| K001 | ${scope} | ${entry} | — | manual |`,
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        "",
      ].join("\n");
    } else if (type === "pattern") {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        `| P001 | ${entry} | — | ${scope} |`,
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        "",
      ].join("\n");
    } else {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        `| L001 | ${entry} | — | — | ${scope} |`,
        "",
      ].join("\n");
    }
    await saveFile(knowledgePath, content);
  }
}

export async function loadActiveOverrides(basePath: string): Promise<Override[]> {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const content = await loadFile(overridesPath);
  if (!content) return [];
  return parseOverrides(content).filter(o => o.scope === "active");
}

export function parseOverrides(content: string): Override[] {
  const overrides: Override[] = [];
  const blocks = content.split(/^## Override: /m).slice(1);

  for (const block of blocks) {
    const lines = block.split("\n");
    const timestamp = lines[0]?.trim() ?? "";
    let change = "";
    let scope: "active" | "resolved" = "active";
    let appliedAt = "";

    for (const line of lines) {
      const changeMatch = line.match(/^\*\*Change:\*\*\s*(.+)$/);
      if (changeMatch) change = changeMatch[1].trim();
      const scopeMatch = line.match(/^\*\*Scope:\*\*\s*(.+)$/);
      if (scopeMatch) scope = scopeMatch[1].trim() as "active" | "resolved";
      const appliedMatch = line.match(/^\*\*Applied-at:\*\*\s*(.+)$/);
      if (appliedMatch) appliedAt = appliedMatch[1].trim();
    }

    if (change) {
      overrides.push({ timestamp, change, scope, appliedAt });
    }
  }

  return overrides;
}

export function formatOverridesSection(overrides: Override[]): string {
  if (overrides.length === 0) return "";

  const entries = overrides.map((o, i) => [
    `${i + 1}. **${o.change}**`,
    `   _Issued: ${o.timestamp} during ${o.appliedAt}_`,
  ].join("\n")).join("\n");

  return [
    "## Active Overrides (supersede plan content)",
    "",
    "The following overrides were issued by the user and supersede any conflicting content in plan documents below. Follow these overrides even if they contradict the inlined task plan.",
    "",
    entries,
    "",
  ].join("\n");
}

export async function resolveAllOverrides(basePath: string): Promise<void> {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const content = await loadFile(overridesPath);
  if (!content) return;
  const updated = content.replace(/\*\*Scope:\*\* active/g, "**Scope:** resolved");
  await saveFile(overridesPath, updated);
}
