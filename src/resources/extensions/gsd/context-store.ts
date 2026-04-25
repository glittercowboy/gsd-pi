// GSD Context Store — Query Layer & Formatters
//
// Typed query functions for decisions and requirements from the DB views,
// with optional filtering. Format functions produce prompt-injectable markdown.
// All functions degrade gracefully: return empty results when DB unavailable, never throw.

import { isDbAvailable, _getAdapter } from './gsd-db.js';
import type { Decision, Requirement } from './types.js';

// ─── Query Functions ───────────────────────────────────────────────────────

export interface DecisionQueryOpts {
  milestoneId?: string;
  scope?: string;
}

export interface RequirementQueryOpts {
  milestoneId?: string;
  sliceId?: string;
  status?: string;
}

/**
 * Query active (non-superseded) decisions with optional filters.
 * - milestoneId: filters where when_context LIKE '%milestoneId%'
 * - scope: filters where scope = :scope (exact match)
 *
 * Returns [] if DB is not available. Never throws.
 */
export function queryDecisions(opts?: DecisionQueryOpts): Decision[] {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];

  try {
    const clauses: string[] = ['superseded_by IS NULL'];
    const params: Record<string, unknown> = {};

    if (opts?.milestoneId) {
      clauses.push('when_context LIKE :milestone_pattern');
      params[':milestone_pattern'] = `%${opts.milestoneId}%`;
    }

    if (opts?.scope) {
      clauses.push('scope = :scope');
      params[':scope'] = opts.scope;
    }

    const sql = `SELECT * FROM decisions WHERE ${clauses.join(' AND ')} ORDER BY seq`;
    const rows = adapter.prepare(sql).all(params);

    return rows.map(row => ({
      seq: row['seq'] as number,
      id: row['id'] as string,
      when_context: row['when_context'] as string,
      scope: row['scope'] as string,
      decision: row['decision'] as string,
      choice: row['choice'] as string,
      rationale: row['rationale'] as string,
      revisable: row['revisable'] as string,
      made_by: (row['made_by'] as string as import('./types.js').DecisionMadeBy) ?? 'agent',
      superseded_by: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Query active (non-superseded) requirements with optional filters.
 * - milestoneId: combined with sliceId for precise filtering (e.g. %M005/S01%)
 * - sliceId: filters where primary_owner LIKE '%pattern%' OR supporting_slices LIKE '%pattern%'
 * - status: filters where status = :status (exact match)
 *
 * Returns [] if DB is not available. Never throws.
 */
export function queryRequirements(opts?: RequirementQueryOpts): Requirement[] {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];

  try {
    const clauses: string[] = ['superseded_by IS NULL'];
    const params: Record<string, unknown> = {};

    // Combined milestone+slice filtering for precise scoping
    if (opts?.milestoneId && opts?.sliceId) {
      // Use combined pattern like %M005/S01% to avoid cross-milestone contamination
      clauses.push('(primary_owner LIKE :combined_pattern OR supporting_slices LIKE :combined_pattern)');
      params[':combined_pattern'] = `%${opts.milestoneId}/${opts.sliceId}%`;
    } else if (opts?.sliceId) {
      // Slice-only filtering (legacy behavior)
      clauses.push('(primary_owner LIKE :slice_pattern OR supporting_slices LIKE :slice_pattern)');
      params[':slice_pattern'] = `%${opts.sliceId}%`;
    } else if (opts?.milestoneId) {
      // Milestone-only filtering
      clauses.push('(primary_owner LIKE :milestone_pattern OR supporting_slices LIKE :milestone_pattern)');
      params[':milestone_pattern'] = `%${opts.milestoneId}%`;
    }

    if (opts?.status) {
      clauses.push('status = :status');
      params[':status'] = opts.status;
    }

    const sql = `SELECT * FROM requirements WHERE ${clauses.join(' AND ')} ORDER BY id`;
    const rows = adapter.prepare(sql).all(params);

    return rows.map(row => ({
      id: row['id'] as string,
      class: row['class'] as string,
      status: row['status'] as string,
      description: row['description'] as string,
      why: row['why'] as string,
      source: row['source'] as string,
      primary_owner: row['primary_owner'] as string,
      supporting_slices: row['supporting_slices'] as string,
      validation: row['validation'] as string,
      notes: row['notes'] as string,
      full_content: row['full_content'] as string,
      superseded_by: null,
    }));
  } catch {
    return [];
  }
}

// ─── Format Functions ──────────────────────────────────────────────────────

/**
 * Format decisions as a markdown table matching DECISIONS.md format.
 * Returns empty string for empty input.
 */
export function formatDecisionsForPrompt(decisions: Decision[]): string {
  if (decisions.length === 0) return '';

  const header = '| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |';
  const separator = '|---|------|-------|----------|--------|-----------|------------|---------|';
  const rows = decisions.map(d =>
    `| ${d.id} | ${d.when_context} | ${d.scope} | ${d.decision} | ${d.choice} | ${d.rationale} | ${d.revisable} | ${d.made_by ?? 'agent'} |`,
  );

  return [header, separator, ...rows].join('\n');
}

/**
 * Format requirements as structured H3 sections matching REQUIREMENTS.md format.
 * Returns empty string for empty input.
 */
export function formatRequirementsForPrompt(requirements: Requirement[]): string {
  if (requirements.length === 0) return '';

  return requirements.map(r => {
    const lines: string[] = [
      `### ${r.id}: ${r.description}`,
      '',
      `- **Class:** ${r.class}`,
      `- **Status:** ${r.status}`,
      `- **Why:** ${r.why}`,
      `- **Source:** ${r.source}`,
      `- **Primary Owner:** ${r.primary_owner}`,
    ];

    if (r.supporting_slices) {
      lines.push(`- **Supporting Slices:** ${r.supporting_slices}`);
    }

    lines.push(`- **Validation:** ${r.validation}`);

    if (r.notes) {
      lines.push(`- **Notes:** ${r.notes}`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

// ─── Artifact Query Functions ──────────────────────────────────────────────

/**
 * Query a hierarchy artifact by its relative path.
 * Returns the full_content string or null if not found/unavailable.
 * Never throws.
 */
export function queryArtifact(path: string): string | null {
  if (!isDbAvailable()) return null;
  const adapter = _getAdapter();
  if (!adapter) return null;

  try {
    const row = adapter.prepare('SELECT full_content FROM artifacts WHERE path = :path').get({ ':path': path });
    if (!row) return null;
    const content = row['full_content'] as string;
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Query PROJECT.md content from the artifacts table.
 * PROJECT.md is stored with the relative path 'PROJECT.md' by the importer.
 * Returns the content string or null if not found/unavailable.
 * Never throws.
 */
export function queryProject(): string | null {
  return queryArtifact('PROJECT.md');
}

// ─── Knowledge Query ───────────────────────────────────────────────────────

/**
 * Filter KNOWLEDGE.md sections by keyword matching.
 *
 * Structure-adaptive (issue #4719): files that organise entries as H3 items
 * under one or more H2 topics are filtered at H3 granularity. Files with only
 * H2 topic headers (no H3) fall back to H2-level filtering for backwards
 * compatibility.
 *
 * Matches keywords case-insensitively against:
 * 1. Section header text
 * 2. First paragraph of section content (up to first blank line or next heading)
 *
 * Per D020, returns empty string (not null) when no matches found.
 * This signals "no relevant knowledge" vs "file not found".
 *
 * @param content - Full KNOWLEDGE.md content
 * @param keywords - Keywords to match (case-insensitive)
 * @returns Concatenated matching sections with their original heading prefix, or empty string
 */
export async function queryKnowledge(content: string, keywords: string[]): Promise<string> {
  if (!content || keywords.length === 0) return '';

  // Lazy import to avoid circular dependency
  const { extractAllSections } = await import('./files.js');

  // Prefer H3 granularity when available; fall back to H2 for H2-only files.
  // This prevents single-H2-with-many-H3 layouts from returning the entire
  // file on a keyword match against the H2 header or its first paragraph.
  const h3Sections = extractAllSections(content, 3);
  const useH3 = h3Sections.size > 0;
  const sections = useH3 ? h3Sections : extractAllSections(content, 2);
  if (sections.size === 0) return '';
  const prefix = useH3 ? '###' : '##';

  // Trim, lowercase, drop empties, and de-dupe so callers can pass raw
  // user-provided strings without risking empty-string / whitespace matches.
  const normalizedKeywords = [...new Set(
    keywords
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0),
  )];
  if (normalizedKeywords.length === 0) return '';

  const matchingSections: string[] = [];

  for (const [header, body] of sections) {
    // Extract first paragraph: everything up to first blank line or next heading
    const firstParagraph = body.split(/\n\s*\n|\n#/)[0] || '';

    const headerLower = header.toLowerCase();
    const paragraphLower = firstParagraph.toLowerCase();

    const matches = normalizedKeywords.some(kw =>
      headerLower.includes(kw) || paragraphLower.includes(kw),
    );

    if (matches) {
      matchingSections.push(`${prefix} ${header}\n\n${body}`);
    }
  }

  return matchingSections.join('\n\n');
}

// ─── Roadmap Excerpt Formatter ─────────────────────────────────────────────

/**
 * Format a minimal roadmap excerpt for prompt injection.
 * Parses the slice table from roadmap content, extracts:
 * 1. Header row + separator
 * 2. Predecessor row (if sliceId depends on one via the Depends column)
 * 3. Target slice row
 * 4. Reference directive pointing to full roadmap path
 *
 * Per D021, this minimizes injected content while preserving dependency awareness.
 * Returns empty string if sliceId is not found in the table.
 * Never throws.
 *
 * @param roadmapContent - Full content of the M###-ROADMAP.md file
 * @param sliceId - Target slice ID (e.g. 'S02')
 * @param roadmapPath - Optional path for reference directive (defaults to generic)
 */
export function formatRoadmapExcerpt(
  roadmapContent: string,
  sliceId: string,
  roadmapPath = 'ROADMAP.md',
): string {
  if (!roadmapContent || !sliceId) return '';

  const lines = roadmapContent.split('\n');

  // Find the slice table header: | ID | Slice | ... (case insensitive)
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && /^\s*\|\s*ID\s*\|\s*Slice\s*\|/i.test(line)) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) return '';

  // The separator should be the next line (|---|---|...)
  const separatorIndex = headerIndex + 1;
  if (separatorIndex >= lines.length) return '';

  const headerLine = lines[headerIndex];
  const separatorLine = lines[separatorIndex];

  // Validate separator line looks like |---|---|... (may include : for alignment)
  if (!separatorLine || !/^\s*\|[\s:\-|]+\|/.test(separatorLine)) return '';

  // Parse table rows after separator
  interface SliceRow {
    line: string;
    id: string;
    depends: string;
  }

  const sliceRows: SliceRow[] = [];
  for (let i = separatorIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim().startsWith('|')) break; // End of table

    // Parse row: | ID | Slice | Risk | Depends | Done | After this |
    const cells = line.split('|').map(c => c.trim());
    // cells[0] is empty (before first |), cells[1] is ID, etc.
    if (cells.length < 5) continue;

    const id = cells[1] || '';
    const depends = cells[4] || ''; // Depends column (0-indexed: empty, ID, Slice, Risk, Depends, ...)

    sliceRows.push({ line, id, depends });
  }

  // Find target slice row
  const targetRow = sliceRows.find(r => r.id === sliceId);
  if (!targetRow) return '';

  // Find predecessor if target depends on one
  // Depends column may contain: '—', 'S01', 'S01, S02', etc.
  let predecessorRow: SliceRow | undefined;
  const dependsRaw = targetRow.depends;
  if (dependsRaw && dependsRaw !== '—' && dependsRaw !== '-') {
    // Extract first dependency (e.g. 'S01' from 'S01, S02')
    const depMatch = dependsRaw.match(/S\d+/);
    if (depMatch) {
      predecessorRow = sliceRows.find(r => r.id === depMatch[0]);
    }
  }

  // Build excerpt
  const excerptLines: string[] = [headerLine!, separatorLine!];

  if (predecessorRow) {
    excerptLines.push(predecessorRow.line);
  }

  excerptLines.push(targetRow.line);

  // Add reference directive
  excerptLines.push('');
  excerptLines.push(`> See full roadmap: ${roadmapPath}`);

  return excerptLines.join('\n');
}
