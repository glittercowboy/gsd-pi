// GSD Extension - Legacy Parsers
// parseRoadmap() and parsePlan() extracted from files.ts.
// Used only by: md-importer.ts (migration), state.ts (pre-migration fallback),
// markdown-renderer.ts (detectStaleRenders disk-vs-DB comparison),
// commands-maintenance.ts (cold-path branch cleanup), and tests.
//
// NOT used in the dispatch loop or any hot-path runtime code.

import { extractSection, parseBullets, extractBoldField, extractAllSections, registerCacheClearCallback } from './files.js';
import { splitFrontmatter } from '../shared/frontmatter.js';
import { nativeParseRoadmap, nativeParsePlanFile } from './native-parser-bridge.js';
import { debugTime, debugCount } from './debug-logger.js';
import { CACHE_MAX } from './constants.js';

import type {
  Roadmap, BoundaryMapEntry,
  SlicePlan, TaskPlanEntry,
} from './types.js';

// Re-export parseRoadmapSlices so callers can import all legacy parsers from one module
import { parseRoadmapSlices } from './roadmap-slices.js';
export { parseRoadmapSlices };

// ─── Parse Cache (local to this module) ───────────────────────────────────

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

/** Clear the legacy parser cache. Called by clearParseCache() in files.ts. */
export function clearLegacyParseCache(): void {
  _parseCache.clear();
}

// Register with files.ts so clearParseCache() also clears our cache
registerCacheClearCallback(clearLegacyParseCache);

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

// ─── Slice Plan Parser ─────────────────────────────────────────────────────

export function parsePlan(content: string): SlicePlan {
  return cachedParse(content, 'plan', _parsePlanImpl);
}

function _parsePlanImpl(content: string): SlicePlan {
  const stopTimer = debugTime("parse-plan");
  const [, body] = splitFrontmatter(content);
  // Try native parser first for better performance
  const nativeResult = nativeParsePlanFile(body);
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

  const lines = body.split('\n');

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

  const goal = extractBoldField(body, 'Goal') || '';
  const demo = extractBoldField(body, 'Demo') || '';

  const mhSection = extractSection(body, 'Must-Haves');
  const mustHaves = mhSection ? parseBullets(mhSection) : [];

  // Parse tasks from ## Tasks section first, then scan the full body for any
  // task checkboxes that were missed. Multi-task plans can interleave T01 detail
  // headings (## Steps, ## Must-Haves) before T02's checkbox, which causes
  // extractSection("Tasks") to stop at the first ## heading and miss T02+ (#3105).
  const tasksSection = extractSection(body, 'Tasks');
  const tasks: TaskPlanEntry[] = [];

  // Parse task entries from a set of lines, appending to `tasks`.
  const parseTaskLines = (lines: string[], knownIds: Set<string>): void => {
    let currentTask: TaskPlanEntry | null = null;

    for (const line of lines) {
      const cbMatch = line.match(/^-\s+\[([ xX])\]\s+\*\*([\w.]+):\s+(.+?)\*\*\s*(.*)/);
      // Heading-style: ### T01 -- Title, ### T01: Title, ### T01 — Title
      const hdMatch = !cbMatch
        ? line.match(/^#{2,4}\s+([A-Z]+\d+(?:\.[A-Z]+\d+)*)\s*(?:--|—|:)\s*(.+)/)
        : null;
      if (cbMatch || hdMatch) {
        const taskId = cbMatch ? cbMatch[2] : hdMatch![1];
        // Skip tasks already found in the Tasks section
        if (knownIds.has(taskId)) {
          currentTask = null;
          continue;
        }
        if (currentTask) tasks.push(currentTask);

        if (cbMatch) {
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
        } else {
          const rest = hdMatch![2] || '';
          const titleEstMatch = rest.match(/^(.+?)\s*`est:([^`]+)`\s*$/);
          const title = titleEstMatch ? titleEstMatch[1].trim() : rest.trim();
          const estimate = titleEstMatch ? titleEstMatch[2] : '';

          currentTask = {
            id: hdMatch![1],
            title,
            description: '',
            done: false,
            estimate,
          };
        }
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
  };

  if (tasksSection) {
    parseTaskLines(tasksSection.split('\n'), new Set());
  }

  // Second pass: scan the full body for task checkboxes outside ## Tasks.
  // This handles interleaved plans where T02+ appear after T01's detail headings.
  const foundIds = new Set(tasks.map(t => t.id));
  parseTaskLines(body.split('\n'), foundIds);

  const filesSection = extractSection(body, 'Files Likely Touched');
  const filesLikelyTouched = filesSection ? parseBullets(filesSection) : [];

  const result = { id, title, goal, demo, mustHaves, tasks, filesLikelyTouched };
  stopTimer({ tasks: tasks.length });
  debugCount("parsePlanCalls");
  return result;
}
