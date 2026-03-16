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
      superseded_by: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Query active (non-superseded) requirements with optional filters.
 * - sliceId: filters where primary_owner LIKE '%sliceId%' OR supporting_slices LIKE '%sliceId%'
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

    if (opts?.sliceId) {
      clauses.push('(primary_owner LIKE :slice_pattern OR supporting_slices LIKE :slice_pattern)');
      params[':slice_pattern'] = `%${opts.sliceId}%`;
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

  const header = '| # | When | Scope | Decision | Choice | Rationale | Revisable? |';
  const separator = '|---|------|-------|----------|--------|-----------|------------|';
  const rows = decisions.map(d =>
    `| ${d.id} | ${d.when_context} | ${d.scope} | ${d.decision} | ${d.choice} | ${d.rationale} | ${d.revisable} |`,
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
