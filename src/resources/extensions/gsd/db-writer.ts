// GSD DB Writer — Markdown generators + DB-first write helpers
//
// The missing DB→markdown direction. S03 established markdown→DB (md-importer.ts).
// This module generates DECISIONS.md and REQUIREMENTS.md from DB state,
// computes next decision IDs, and provides write helpers that upsert to DB
// then regenerate the corresponding markdown file.
//
// Critical invariant: generated markdown must round-trip through
// parseDecisionsTable() and parseRequirementsSections() with field fidelity.

import { join, resolve } from 'node:path';
import type { Decision, Requirement } from './types.js';
import { resolveGsdRootFile } from './paths.js';
import { saveFile } from './files.js';

// ─── Markdown Generators ──────────────────────────────────────────────────

/**
 * Generate full DECISIONS.md content from an array of Decision objects.
 * Produces the canonical format: H1 header, HTML comment block, table header,
 * separator, and one data row per decision.
 *
 * Column order: #, When, Scope, Decision, Choice, Rationale, Revisable?
 */
export function generateDecisionsMd(decisions: Decision[]): string {
  const lines: string[] = [];

  lines.push('# Decisions Register');
  lines.push('');
  lines.push('<!-- Append-only. Never edit or remove existing rows.');
  lines.push('     To reverse a decision, add a new row that supersedes it.');
  lines.push('     Read this file at the start of any planning or research phase. -->');
  lines.push('');
  lines.push('| # | When | Scope | Decision | Choice | Rationale | Revisable? |');
  lines.push('|---|------|-------|----------|--------|-----------|------------|');

  for (const d of decisions) {
    // Escape pipe characters within cell values to preserve table structure
    const cells = [
      d.id,
      d.when_context,
      d.scope,
      d.decision,
      d.choice,
      d.rationale,
      d.revisable,
    ].map(cell => (cell ?? '').replace(/\|/g, '\\|'));

    lines.push(`| ${cells.join(' | ')} |`);
  }

  return lines.join('\n') + '\n';
}

// ─── Requirements Markdown Generator ──────────────────────────────────────

/** Status values that map to specific sections, in display order. */
const STATUS_SECTION_MAP: Array<{ status: string; heading: string }> = [
  { status: 'active', heading: 'Active' },
  { status: 'validated', heading: 'Validated' },
  { status: 'deferred', heading: 'Deferred' },
  { status: 'out-of-scope', heading: 'Out of Scope' },
];

/**
 * Generate full REQUIREMENTS.md content from an array of Requirement objects.
 * Groups requirements by status into sections (## Active, ## Validated, etc.),
 * each containing ### RXXX — Description headings with bullet fields.
 * Only emits sections that have content. Appends Traceability table and
 * Coverage Summary at the bottom.
 */
export function generateRequirementsMd(requirements: Requirement[]): string {
  const lines: string[] = [];

  lines.push('# Requirements');
  lines.push('');
  lines.push('This file is the explicit capability and coverage contract for the project.');
  lines.push('');

  // Group by status
  const byStatus = new Map<string, Requirement[]>();
  for (const r of requirements) {
    const status = (r.status || 'active').toLowerCase();
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status)!.push(r);
  }

  // Emit sections in canonical order
  for (const { status, heading } of STATUS_SECTION_MAP) {
    const reqs = byStatus.get(status);
    if (!reqs || reqs.length === 0) continue;

    lines.push(`## ${heading}`);
    lines.push('');

    for (const r of reqs) {
      lines.push(`### ${r.id} — ${r.description || 'Untitled'}`);

      // Emit bullet fields — only those with content
      if (r.class) lines.push(`- Class: ${r.class}`);
      if (r.status) lines.push(`- Status: ${r.status}`);
      if (r.description) lines.push(`- Description: ${r.description}`);
      if (r.why) lines.push(`- Why it matters: ${r.why}`);
      if (r.source) lines.push(`- Source: ${r.source}`);
      if (r.primary_owner) lines.push(`- Primary owning slice: ${r.primary_owner}`);
      if (r.supporting_slices) lines.push(`- Supporting slices: ${r.supporting_slices}`);
      if (r.validation) lines.push(`- Validation: ${r.validation}`);
      if (r.notes) lines.push(`- Notes: ${r.notes}`);
      lines.push('');
    }
  }

  // Traceability table
  lines.push('## Traceability');
  lines.push('');
  lines.push('| ID | Class | Status | Primary owner | Supporting | Proof |');
  lines.push('|---|---|---|---|---|---|');

  for (const r of requirements) {
    const proof = r.validation || 'unmapped';
    lines.push(
      `| ${r.id} | ${r.class || ''} | ${r.status || ''} | ${r.primary_owner || 'none'} | ${r.supporting_slices || 'none'} | ${proof} |`,
    );
  }

  lines.push('');

  // Coverage Summary
  const activeCount = byStatus.get('active')?.length ?? 0;
  const validatedReqs = byStatus.get('validated') ?? [];
  const validatedIds = validatedReqs.map(r => r.id).join(', ');

  lines.push('## Coverage Summary');
  lines.push('');
  lines.push(`- Active requirements: ${activeCount}`);
  lines.push(`- Mapped to slices: ${activeCount}`);
  lines.push(`- Validated: ${validatedReqs.length}${validatedIds ? ` (${validatedIds})` : ''}`);
  lines.push(`- Unmapped active requirements: 0`);

  return lines.join('\n') + '\n';
}

// ─── Next Decision ID ─────────────────────────────────────────────────────

/**
 * Compute the next decision ID from the current DB state.
 * Queries MAX(CAST(SUBSTR(id, 2) AS INTEGER)) from decisions table.
 * Returns D001 if no decisions exist. Zero-pads to 3 digits.
 */
export async function nextDecisionId(): Promise<string> {
  try {
    const db = await import('./gsd-db.js');
    const adapter = db._getAdapter();
    if (!adapter) return 'D001';

    const row = adapter
      .prepare('SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as max_num FROM decisions')
      .get();

    const maxNum = row ? (row['max_num'] as number | null) : null;
    if (maxNum == null || isNaN(maxNum)) return 'D001';

    const next = maxNum + 1;
    return `D${String(next).padStart(3, '0')}`;
  } catch (err) {
    process.stderr.write(`gsd-db: nextDecisionId failed: ${(err as Error).message}\n`);
    return 'D001';
  }
}

// ─── Save Decision to DB + Regenerate Markdown ────────────────────────────

export interface SaveDecisionFields {
  scope: string;
  decision: string;
  choice: string;
  rationale: string;
  revisable?: string;
  when_context?: string;
}

/**
 * Save a new decision to DB and regenerate DECISIONS.md.
 * Auto-assigns the next ID via nextDecisionId().
 * Returns the assigned ID.
 */
export async function saveDecisionToDb(
  fields: SaveDecisionFields,
  basePath: string,
): Promise<{ id: string }> {
  try {
    const db = await import('./gsd-db.js');

    const id = await nextDecisionId();

    db.upsertDecision({
      id,
      when_context: fields.when_context ?? '',
      scope: fields.scope,
      decision: fields.decision,
      choice: fields.choice,
      rationale: fields.rationale,
      revisable: fields.revisable ?? 'Yes',
      superseded_by: null,
    });

    // Fetch all decisions (including superseded for the full register)
    const adapter = db._getAdapter();
    let allDecisions: Decision[] = [];
    if (adapter) {
      const rows = adapter.prepare('SELECT * FROM decisions ORDER BY seq').all();
      allDecisions = rows.map(row => ({
        seq: row['seq'] as number,
        id: row['id'] as string,
        when_context: row['when_context'] as string,
        scope: row['scope'] as string,
        decision: row['decision'] as string,
        choice: row['choice'] as string,
        rationale: row['rationale'] as string,
        revisable: row['revisable'] as string,
        superseded_by: (row['superseded_by'] as string) ?? null,
      }));
    }

    const md = generateDecisionsMd(allDecisions);
    const filePath = resolveGsdRootFile(basePath, 'DECISIONS');
    await saveFile(filePath, md);

    return { id };
  } catch (err) {
    process.stderr.write(`gsd-db: saveDecisionToDb failed: ${(err as Error).message}\n`);
    throw err;
  }
}

// ─── Update Requirement in DB + Regenerate Markdown ───────────────────────

/**
 * Update a requirement in DB and regenerate REQUIREMENTS.md.
 * Fetches existing requirement, merges updates, upserts, then regenerates.
 */
export async function updateRequirementInDb(
  id: string,
  updates: Partial<Requirement>,
  basePath: string,
): Promise<void> {
  try {
    const db = await import('./gsd-db.js');

    const existing = db.getRequirementById(id);
    if (!existing) {
      throw new Error(`Requirement ${id} not found`);
    }

    // Merge updates into existing
    const merged: Requirement = {
      ...existing,
      ...updates,
      id: existing.id, // ID cannot be changed
    };

    db.upsertRequirement(merged);

    // Fetch ALL requirements (including superseded) for full file regeneration
    const adapter = db._getAdapter();
    let allRequirements: Requirement[] = [];
    if (adapter) {
      const rows = adapter.prepare('SELECT * FROM requirements ORDER BY id').all();
      allRequirements = rows.map(row => ({
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
        superseded_by: (row['superseded_by'] as string) ?? null,
      }));
    }

    // Filter to non-superseded for the markdown file
    // (superseded requirements don't appear in section headings)
    const nonSuperseded = allRequirements.filter(r => r.superseded_by == null);

    const md = generateRequirementsMd(nonSuperseded);
    const filePath = resolveGsdRootFile(basePath, 'REQUIREMENTS');
    await saveFile(filePath, md);
  } catch (err) {
    process.stderr.write(`gsd-db: updateRequirementInDb failed: ${(err as Error).message}\n`);
    throw err;
  }
}

// ─── Save Artifact to DB + Disk ───────────────────────────────────────────

export interface SaveArtifactOpts {
  path: string;
  artifact_type: string;
  content: string;
  milestone_id?: string;
  slice_id?: string;
  task_id?: string;
}

/**
 * Save an artifact to DB and write the corresponding markdown file to disk.
 * The path is relative to .gsd/ (e.g. "milestones/M001/slices/S06/tasks/T01-SUMMARY.md").
 * The full file path is computed as basePath + '.gsd/' + path.
 */
export async function saveArtifactToDb(
  opts: SaveArtifactOpts,
  basePath: string,
): Promise<void> {
  try {
    const db = await import('./gsd-db.js');

    db.insertArtifact({
      path: opts.path,
      artifact_type: opts.artifact_type,
      milestone_id: opts.milestone_id ?? null,
      slice_id: opts.slice_id ?? null,
      task_id: opts.task_id ?? null,
      full_content: opts.content,
    });

    // Write the file to disk (guard against path traversal)
    const gsdDir = resolve(basePath, '.gsd');
    const fullPath = resolve(basePath, '.gsd', opts.path);
    if (!fullPath.startsWith(gsdDir)) {
      throw new Error(`saveArtifactToDb: path escapes .gsd/ directory: ${opts.path}`);
    }
    await saveFile(fullPath, opts.content);
  } catch (err) {
    process.stderr.write(`gsd-db: saveArtifactToDb failed: ${(err as Error).message}\n`);
    throw err;
  }
}
