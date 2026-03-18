// Old .planning format per-file parsers
// Pure functions that take file content (string) and return typed data.
// Zero Pi dependencies — uses only exported helpers from files.ts.

import { splitFrontmatter, parseFrontmatterMap, extractBoldField } from '../files.js';
import { normalizeStringArray } from '../../shared/mod.js';

import type {
  PlanningRoadmap,
  PlanningRoadmapMilestone,
  PlanningRoadmapEntry,
  PlanningPlan,
  PlanningPlanFrontmatter,
  PlanningPlanMustHaves,
  PlanningSummary,
  PlanningSummaryFrontmatter,
  PlanningSummaryRequires,
  PlanningRequirement,
  PlanningState,
  PlanningConfig,
} from './types.js';

// Re-export PlanningProjectMeta — not in types.ts yet, use string for project field
// Actually PlanningProjectMeta isn't in types.ts — project is stored as string | null.
// We'll keep parseOldProject returning a simple shape.

// ─── XML-in-Markdown Extraction ────────────────────────────────────────────

/**
 * Extract content between XML-like tags in markdown.
 * NOT a real XML parser — handles `<tag>content</tag>` with markdown inside.
 */
function extractXmlTag(content: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = regex.exec(content);
  return match ? match[1].trim() : '';
}

/**
 * Extract all nested `<task>` entries from within a `<tasks>` block.
 */
function extractTasks(content: string): string[] {
  const tasksBlock = extractXmlTag(content, 'tasks');
  if (!tasksBlock) return [];

  const tasks: string[] = [];
  const regex = /<task>([\s\S]*?)<\/task>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tasksBlock)) !== null) {
    const trimmed = match[1].trim();
    if (trimmed) tasks.push(trimmed);
  }
  return tasks;
}

// ─── Roadmap Parser ────────────────────────────────────────────────────────

/** Parse a checkbox phase entry line: `- [x] 29 — Auth System` */
function parsePhaseEntry(line: string): PlanningRoadmapEntry | null {
  // Strip bold markers (**) for uniform matching — old roadmaps often bold phase entries
  const stripped = line.replace(/\*\*/g, '');

  // Format 1: - [x] Phase 25: Title (N/N plans) -- completed ...
  // Also handles: - [x] Phase 25: Title - Description (completed ...)
  const fmtPhaseColon = stripped.match(/^-\s+\[([ xX])\]\s+(?:Phase\s+)?(\d+(?:\.\d+)?)\s*:\s*(.+)$/);
  if (fmtPhaseColon) {
    let title = fmtPhaseColon[3].trim();
    // Strip trailing parentheticals, plan counts, and completion notes
    title = title.replace(/\s*\(\d+\/\d+\s+plans?\)/, '')
                 .replace(/\s*--\s+.*$/, '')
                 .replace(/\s*-\s+.*$/, '')  // strip "- description" suffix
                 .replace(/\s*\(completed.*\)$/i, '')
                 .replace(/\s*\(shipped.*\)$/i, '')
                 .trim();
    return {
      number: parseFloat(fmtPhaseColon[2]),
      title,
      done: fmtPhaseColon[1].toLowerCase() === 'x',
      raw: line,
    };
  }

  // Format 2: - [x] 25 — Title (em-dash/en-dash only — NOT plain hyphen to avoid plan file refs)
  const fmtDash = stripped.match(/^-\s+\[([ xX])\]\s+(?:Phase\s+)?(\d+(?:\.\d+)?)\s*[—–]\s*(.+)$/);
  if (fmtDash) {
    let title = fmtDash[3].trim();
    title = title.replace(/\s*\(\d+\/\d+\s+plans?\)/, '')
                 .replace(/\s*--\s+.*$/, '')
                 .trim();
    return {
      number: parseFloat(fmtDash[2]),
      title,
      done: fmtDash[1].toLowerCase() === 'x',
      raw: line,
    };
  }

  return null;
}

/**
 * Parse old-format ROADMAP.md.
 * Handles two formats:
 * 1. Flat phase lists — checkbox lines under a single Phases heading
 * 2. Milestone-sectioned — `## v2.0 — Title` headings with optional `<details>` blocks
 * 3. Details-sectioned — `<details><summary>v1.0 Title (Phases N-M)</summary>` blocks with phase checkboxes inside
 */
export function parseOldRoadmap(content: string): PlanningRoadmap {
  const result: PlanningRoadmap = {
    raw: content,
    milestones: [],
    phases: [],
  };

  const lines = content.split('\n');

  // ─── Strategy 1: Detect <details><summary>vN.N Title</summary> blocks ───
  // This handles the format where milestones are <details> blocks containing phase checkboxes
  const detailsMilestones = parseDetailsBlockMilestones(lines);
  if (detailsMilestones.length > 0) {
    result.milestones = detailsMilestones;

    // Also check for non-collapsed milestone sections (### v3.0 Title)
    // that follow the <details> blocks
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^###\s+(v[\d.]+)\s+(.+?)(?:\s*\(.*\))?\s*$/);
      if (heading) {
        // Already captured as a details block?
        const id = heading[1];
        if (result.milestones.some(m => m.id === id)) continue;

        // Collect phase entries until next ## or ### heading
        const phases: PlanningRoadmapEntry[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^##?\s/.test(lines[j]) || /^###\s/.test(lines[j])) break;
          const entry = parsePhaseEntry(lines[j].trim());
          if (entry) phases.push(entry);
        }
        result.milestones.push({
          id,
          title: heading[2].trim(),
          collapsed: false,
          phases,
        });
      }
    }
    return result;
  }

  // ─── Strategy 2: Detect ## heading-sectioned milestones ───
  const milestoneHeadingRegex = /^##\s+(.+)$/;
  const milestoneHeadings: { index: number; id: string; title: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(milestoneHeadingRegex);
    if (match) {
      const heading = match[1].trim();
      // Skip generic headings like "## Phases", "## Milestones", "## Phase Details", "## Progress"
      if (/^(phases?|milestones?|phase\s+details?|progress)$/i.test(heading)) continue;
      // Extract milestone ID (e.g. "v2.0" from "v2.0 — Foundation")
      const idMatch = heading.match(/^(v[\d.]+|[\w.-]+)\s*[—–-]\s*(.+)$/);
      if (idMatch) {
        milestoneHeadings.push({ index: i, id: idMatch[1], title: idMatch[2].trim() });
      }
    }
  }

  if (milestoneHeadings.length > 0) {
    // Milestone-sectioned format
    for (let m = 0; m < milestoneHeadings.length; m++) {
      const startIdx = milestoneHeadings[m].index + 1;
      const endIdx = m + 1 < milestoneHeadings.length ? milestoneHeadings[m + 1].index : lines.length;
      const sectionLines = lines.slice(startIdx, endIdx);

      const milestone: PlanningRoadmapMilestone = {
        id: milestoneHeadings[m].id,
        title: milestoneHeadings[m].title,
        collapsed: false,
        phases: [],
      };

      // Check for <details> block
      const sectionText = sectionLines.join('\n');
      if (sectionText.includes('<details>')) {
        milestone.collapsed = true;
      }

      // Extract phase entries from the section (including inside <details>)
      for (const line of sectionLines) {
        const entry = parsePhaseEntry(line.trim());
        if (entry) {
          milestone.phases.push(entry);
        }
      }

      result.milestones.push(milestone);
    }
  } else {
    // ─── Strategy 3: Flat format — just extract all phase checkbox lines ───
    for (const line of lines) {
      const entry = parsePhaseEntry(line.trim());
      if (entry) {
        result.phases.push(entry);
      }
    }
  }

  return result;
}

/**
 * Parse <details><summary>vN.N Title (Phases N-M)</summary>...</details> blocks.
 * Each block becomes a milestone with the phase entries inside it.
 */
function parseDetailsBlockMilestones(lines: string[]): PlanningRoadmapMilestone[] {
  const milestones: PlanningRoadmapMilestone[] = [];
  let inDetails = false;
  let currentMilestone: PlanningRoadmapMilestone | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '<details>') {
      inDetails = true;
      continue;
    }

    if (inDetails && !currentMilestone) {
      // Look for <summary>vN.N Title (Phases N-M) -- STATUS</summary>
      const summaryMatch = trimmed.match(/<summary>\s*(v[\d.]+)\s+(.+?)\s*(?:\(.*\))?\s*(?:--\s*.*)?\s*<\/summary>/);
      if (summaryMatch) {
        currentMilestone = {
          id: summaryMatch[1],
          title: summaryMatch[2].trim(),
          collapsed: true,
          phases: [],
        };
      }
      continue;
    }

    if (trimmed === '</details>') {
      if (currentMilestone) {
        milestones.push(currentMilestone);
        currentMilestone = null;
      }
      inDetails = false;
      continue;
    }

    if (currentMilestone) {
      const entry = parsePhaseEntry(trimmed);
      if (entry) {
        currentMilestone.phases.push(entry);
      }
    }
  }

  return milestones;
}

// ─── Plan Parser (XML-in-Markdown) ─────────────────────────────────────────

/** Strip surrounding quotes from YAML string values */
function unquote(val: unknown): string {
  const s = String(val ?? '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse the must_haves nested structure from frontmatter lines directly.
 * parseFrontmatterMap doesn't handle 3-level nesting well, so we re-parse.
 */
function parseMustHavesFromLines(fmLines: string[]): PlanningPlanMustHaves | null {
  const start = fmLines.findIndex(l => /^must_haves\s*:/.test(l));
  if (start === -1) return null;

  const truths: string[] = [];
  const artifacts: string[] = [];
  const keyLinks: string[] = [];
  let currentList: string[] | null = null;

  for (let i = start + 1; i < fmLines.length; i++) {
    const line = fmLines[i];
    // New top-level key — stop
    if (/^\w/.test(line)) break;
    // Sub-key at 2-space indent
    const subKey = line.match(/^  (\w[\w_]*):/);
    if (subKey) {
      const key = subKey[1];
      if (key === 'truths') currentList = truths;
      else if (key === 'artifacts') currentList = artifacts;
      else if (key === 'key_links') currentList = keyLinks;
      else currentList = null;
      // Check for inline empty array
      if (/:\s*\[\]/.test(line)) currentList = null;
      continue;
    }
    // Array item at 4-space indent
    const item = line.match(/^    - (.+)$/);
    if (item && currentList) {
      currentList.push(item[1].trim());
    }
  }

  if (truths.length === 0 && artifacts.length === 0 && keyLinks.length === 0) return null;
  return { truths, artifacts, key_links: keyLinks };
}

function parsePlanFrontmatter(fm: Record<string, unknown>, fmLines: string[] | null): PlanningPlanFrontmatter {
  const mustHaves = fmLines ? parseMustHavesFromLines(fmLines) : null;

  return {
    phase: unquote(fm.phase),
    plan: unquote(fm.plan),
    type: unquote(fm.type),
    wave: fm.wave !== undefined ? Number(fm.wave) : null,
    depends_on: Array.isArray(fm.depends_on) ? fm.depends_on.map(s => unquote(s)) : [],
    files_modified: Array.isArray(fm.files_modified) ? fm.files_modified.map(s => unquote(s)) : [],
    autonomous: fm.autonomous === 'true' || fm.autonomous === true,
    must_haves: mustHaves,
  };
}

/**
 * Parse old-format plan file with YAML frontmatter and XML-in-markdown sections.
 * Falls back to plain markdown for quick-task plans that lack XML tags.
 */
export function parseOldPlan(content: string, fileName: string = '', planNumber: string = ''): PlanningPlan {
  const [fmLines, body] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const frontmatter = parsePlanFrontmatter(fm, fmLines);

  // Extract XML-in-markdown sections
  const objective = extractXmlTag(content, 'objective');
  const tasks = extractTasks(content);
  const context = extractXmlTag(content, 'context');
  const verification = extractXmlTag(content, 'verification');
  const successCriteria = extractXmlTag(content, 'success_criteria');

  return {
    fileName,
    planNumber: planNumber || String(fm.plan ?? ''),
    frontmatter,
    objective,
    tasks,
    context,
    verification,
    successCriteria,
    raw: content,
  };
}

// ─── Summary Parser (YAML Frontmatter) ─────────────────────────────────────

function parseRequiresArray(raw: unknown): PlanningSummaryRequires[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, string>;
      return { phase: obj.phase ?? '', provides: obj.provides ?? '' };
    }
    return { phase: '', provides: String(item) };
  });
}

// parseFrontmatterMap from shared now supports hyphenated keys natively

function parseSummaryFrontmatter(fm: Record<string, unknown>): PlanningSummaryFrontmatter {
  return {
    phase: unquote(fm.phase),
    plan: unquote(fm.plan),
    subsystem: unquote(fm.subsystem),
    tags: normalizeStringArray(fm.tags),
    requires: parseRequiresArray(fm.requires),
    provides: normalizeStringArray(fm.provides),
    affects: normalizeStringArray(fm.affects),
    'tech-stack': normalizeStringArray(fm['tech-stack']),
    'key-files': normalizeStringArray(fm['key-files']),
    'key-decisions': normalizeStringArray(fm['key-decisions']),
    'patterns-established': normalizeStringArray(fm['patterns-established']),
    duration: unquote(fm.duration),
    completed: unquote(fm.completed),
  };
}

/**
 * Parse old-format summary file with YAML frontmatter.
 */
export function parseOldSummary(content: string, fileName: string = '', planNumber: string = ''): PlanningSummary {
  const [fmLines, body] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};

  return {
    fileName,
    planNumber: planNumber || String(fm.plan ?? ''),
    frontmatter: parseSummaryFrontmatter(fm),
    body,
    raw: content,
  };
}

// ─── Requirements Parser ───────────────────────────────────────────────────

/**
 * Parse old-format REQUIREMENTS.md.
 * Extracts requirement entries from markdown with status sections and requirement headings.
 */
export function parseOldRequirements(content: string): PlanningRequirement[] {
  const requirements: PlanningRequirement[] = [];
  const lines = content.split('\n');

  let currentStatus = '';
  let currentReq: Partial<PlanningRequirement> | null = null;
  let currentRaw: string[] = [];

  function flushReq() {
    if (currentReq?.id && currentReq?.title) {
      requirements.push({
        id: currentReq.id,
        title: currentReq.title,
        status: currentReq.status || currentStatus || 'unknown',
        description: currentReq.description || '',
        raw: currentRaw.join('\n').trim(),
      });
    }
    currentReq = null;
    currentRaw = [];
  }

  for (const line of lines) {
    // Status section heading (## Active, ## Validated, ## Deferred)
    const statusMatch = line.match(/^##\s+(\w[\w\s&]*\w)\s*$/);
    if (statusMatch) {
      flushReq();
      currentStatus = statusMatch[1].toLowerCase();
      continue;
    }

    // Section heading (### Category Name) — use as context for bullet requirements
    const sectionMatch = line.match(/^###\s+(.+)$/);
    if (sectionMatch) {
      // Check if this is a requirement heading (### R001 — Title)
      const reqHeading = sectionMatch[1].match(/^(R\d+)\s*[—–-]\s*(.+)$/);
      if (reqHeading) {
        flushReq();
        currentReq = { id: reqHeading[1], title: reqHeading[2].trim(), status: currentStatus, description: '' };
        currentRaw.push(line);
        continue;
      }
      // Otherwise just note the section — don't flush, could be a category for bullet reqs
      flushReq();
      continue;
    }

    // Bullet-format requirement: - [x] **ID**: Description
    const bulletReqMatch = line.match(/^-\s+\[([ xX])\]\s+\*\*([^*]+)\*\*\s*:\s*(.+)$/);
    if (bulletReqMatch) {
      flushReq();
      const done = bulletReqMatch[1].toLowerCase() === 'x';
      const id = bulletReqMatch[2].trim();
      const desc = bulletReqMatch[3].trim();
      requirements.push({
        id,
        title: desc,
        status: done ? 'complete' : (currentStatus || 'active'),
        description: desc,
        raw: line,
      });
      continue;
    }

    // Description or metadata within a requirement
    if (currentReq) {
      currentRaw.push(line);
      const descMatch = line.match(/^-\s+Description:\s*(.+)$/);
      if (descMatch) {
        currentReq.description = descMatch[1].trim();
        continue;
      }
      const statMatch = line.match(/^-\s+Status:\s*(.+)$/);
      if (statMatch) {
        currentReq.status = statMatch[1].trim();
      }
    }
  }

  flushReq();
  return requirements;
}

// ─── Project Parser ────────────────────────────────────────────────────────

// PlanningProjectMeta isn't in types.ts — project field on PlanningProject is `string | null`.
// This parser returns the raw content as a string. The top-level parser stores it directly.

/**
 * Parse old-format PROJECT.md.
 * Returns the raw content as a string (stored as project field on PlanningProject).
 */
export function parseOldProject(content: string): string {
  return content;
}

// ─── State Parser ──────────────────────────────────────────────────────────

/**
 * Parse old-format STATE.md.
 * Extracts current phase and status from bold-field patterns.
 */
export function parseOldState(content: string): PlanningState {
  const currentPhase = extractBoldField(content, 'Current Phase');
  const status = extractBoldField(content, 'Status');

  return {
    raw: content,
    currentPhase,
    status,
  };
}

// ─── Config Parser ─────────────────────────────────────────────────────────

/**
 * Parse old-format config.json.
 * Returns null on invalid JSON (graceful error handling).
 */
export function parseOldConfig(content: string): PlanningConfig | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PlanningConfig;
  } catch {
    return null;
  }
}
