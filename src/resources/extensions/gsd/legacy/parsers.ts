// GSD Extension — Legacy Markdown Parsers
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * BOUNDARY: These parsers are for display-only callers and `gsd migrate`.
 * HOT-PATH CODE MUST NOT IMPORT FROM THIS MODULE.
 *
 * Permitted callers:
 *   - auto-dashboard.ts, visualizer-data.ts, parallel-eligibility.ts
 *   - auto-worktree.ts, guided-flow.ts, auto-direct-dispatch.ts
 *   - dashboard-overlay.ts, workspace-index.ts, auto-post-unit.ts
 *   - auto-verification.ts, reactive-graph.ts, bootstrap/system-context.ts
 *   - auto-prompts.ts, auto-dispatch.ts
 *   - workflow-migration.ts (gsd migrate)
 *
 * Forbidden callers (use WorkflowEngine queries instead):
 *   - doctor-checks.ts, doctor.ts, doctor-proactive.ts
 *   - auto-recovery.ts, state.ts
 *   - Any dispatch or state-derivation path
 */

import type {
  Roadmap, BoundaryMapEntry,
  SlicePlan, TaskPlanEntry,
  Summary, SummaryFrontmatter, FileModified,
} from '../types.js';

import { extractSection, extractAllSections, extractBoldField, parseBullets } from '../files.js';
import { cachedParse } from '../files.js';
import { splitFrontmatter, parseFrontmatterMap } from '../../shared/frontmatter.js';
import { parseRoadmapSlices } from '../roadmap-slices.js';
import { nativeParseRoadmap, nativeExtractSection, nativeParsePlanFile, nativeParseSummaryFile, NATIVE_UNAVAILABLE } from '../native-parser-bridge.js';
import { debugTime, debugCount } from '../debug-logger.js';

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

  const tasksSection = extractSection(body, 'Tasks');
  const tasks: TaskPlanEntry[] = [];

  if (tasksSection) {
    const taskLines = tasksSection.split('\n');
    let currentTask: TaskPlanEntry | null = null;

    for (const line of taskLines) {
      const cbMatch = line.match(/^-\s+\[([ xX])\]\s+\*\*([\w.]+):\s+(.+?)\*\*\s*(.*)/);
      // Heading-style: ### T01 -- Title, ### T01: Title, ### T01 — Title
      const hdMatch = !cbMatch ? line.match(/^#{2,4}\s+([\w.]+)\s*(?:--|—|:)\s*(.+)/) : null;
      if (cbMatch || hdMatch) {
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
  }

  const filesSection = extractSection(body, 'Files Likely Touched');
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
