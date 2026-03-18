// GSD Markdown Importer
// Parses DECISIONS.md, REQUIREMENTS.md, and hierarchy artifacts from a .gsd/ tree,
// then upserts everything into the SQLite database.
//
// Exports: parseDecisionsTable, parseRequirementsSections, migrateFromMarkdown

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Decision, Requirement } from './types.js';
import {
  upsertDecision,
  upsertRequirement,
  insertArtifact,
  openDatabase,
  transaction,
  _getAdapter,
} from './gsd-db.js';
import {
  resolveGsdRootFile,
  milestonesDir,
  gsdRoot,
  resolveTaskFiles,
} from './paths.js';
import { findMilestoneIds } from './guided-flow.js';

// ─── DECISIONS.md Parser ───────────────────────────────────────────────────

/**
 * Parse a DECISIONS.md markdown table into Decision objects (without seq).
 * Detects `(amends DXXX)` in the Decision column to build supersession info.
 * Returns parsed rows with superseded_by set to null; callers handle chaining.
 */
export function parseDecisionsTable(content: string): Omit<Decision, 'seq'>[] {
  const lines = content.split('\n');
  const results: Omit<Decision, 'seq'>[] = [];

  // Map from amended ID → amending ID for supersession
  const amendsMap = new Map<string, string>();

  for (const line of lines) {
    // Skip non-table lines, header, and separator
    if (!line.trim().startsWith('|')) continue;
    const trimmed = line.trim();
    // Skip separator rows like |---|---|...|
    if (/^\|[\s-|]+\|$/.test(trimmed)) continue;

    // Split on | and strip leading/trailing empty cells
    const cells = trimmed.split('|').map(c => c.trim());
    // Remove first and last empty strings from leading/trailing |
    if (cells.length > 0 && cells[0] === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();

    if (cells.length < 7) continue;

    const id = cells[0].trim();
    // Skip header row
    if (id === '#' || id.toLowerCase() === 'id') continue;
    // Must look like a decision ID (D followed by digits)
    if (!/^D\d+/.test(id)) continue;

    const when_context = cells[1].trim();
    const scope = cells[2].trim();
    const decisionText = cells[3].trim();
    const choice = cells[4].trim();
    const rationale = cells[5].trim();
    const revisable = cells[6].trim();

    // Detect (amends DXXX) in the Decision column
    const amendsMatch = decisionText.match(/\(amends\s+(D\d+)\)/i);
    if (amendsMatch) {
      amendsMap.set(amendsMatch[1], id);
    }

    results.push({
      id,
      when_context,
      scope,
      decision: decisionText,
      choice,
      rationale,
      revisable,
      superseded_by: null,
    });
  }

  // Apply supersession: if D010 amends D001, set D001.superseded_by = D010
  // Handle chains: if D020 amends D010 and D010 amends D001,
  // D001.superseded_by = D010, D010.superseded_by = D020
  for (const row of results) {
    if (amendsMap.has(row.id)) {
      row.superseded_by = amendsMap.get(row.id)!;
    }
  }

  return results;
}

// ─── REQUIREMENTS.md Parser ────────────────────────────────────────────────

const STATUS_SECTIONS: Record<string, string> = {
  '## active': 'active',
  '## validated': 'validated',
  '## deferred': 'deferred',
  '## out of scope': 'out-of-scope',
};

/**
 * Parse REQUIREMENTS.md into Requirement objects.
 * Finds section headings (## Active, ## Validated, ## Deferred, ## Out of Scope),
 * then within each section finds ### RXXX — Title blocks and extracts bullet fields.
 */
export function parseRequirementsSections(content: string): Requirement[] {
  const lines = content.split('\n');
  const results: Requirement[] = [];

  let currentSectionStatus: string | null = null;
  let currentReq: Partial<Requirement> | null = null;
  let currentFullContentLines: string[] = [];

  function flushReq(): void {
    if (currentReq && currentReq.id) {
      currentReq.full_content = currentFullContentLines.join('\n').trim();
      results.push({
        id: currentReq.id!,
        class: currentReq.class ?? '',
        status: currentReq.status ?? currentSectionStatus ?? '',
        description: currentReq.description ?? '',
        why: currentReq.why ?? '',
        source: currentReq.source ?? '',
        primary_owner: currentReq.primary_owner ?? '',
        supporting_slices: currentReq.supporting_slices ?? '',
        validation: currentReq.validation ?? '',
        notes: currentReq.notes ?? '',
        full_content: currentReq.full_content ?? '',
        superseded_by: currentReq.superseded_by ?? null,
      });
    }
    currentReq = null;
    currentFullContentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.trim().toLowerCase();

    // Check for section heading (## Active, ## Validated, etc.)
    if (lineLower.startsWith('## ')) {
      flushReq();
      const matchedSection = Object.entries(STATUS_SECTIONS).find(
        ([prefix]) => lineLower === prefix || lineLower.startsWith(prefix + ' ')
      );
      if (matchedSection) {
        currentSectionStatus = matchedSection[1];
      } else {
        // Sections like ## Traceability, ## Coverage Summary — stop parsing requirements
        currentSectionStatus = null;
      }
      continue;
    }

    // Check for requirement heading (### RXXX — Title)
    const reqMatch = line.match(/^###\s+(R\d+)\s*[—–-]\s*(.+)/);
    if (reqMatch) {
      flushReq();
      if (currentSectionStatus !== null) {
        currentReq = {
          id: reqMatch[1],
          status: currentSectionStatus,
        };
        currentFullContentLines = [line];
      }
      continue;
    }

    // If we're inside a requirement block, collect content and extract bullets
    if (currentReq && currentSectionStatus !== null) {
      currentFullContentLines.push(line);

      // Extract field bullets: "- Field: value" or "- Field name: value"
      const bulletMatch = line.match(/^-\s+(.+?):\s+(.*)/);
      if (bulletMatch) {
        const fieldName = bulletMatch[1].trim().toLowerCase();
        const value = bulletMatch[2].trim();

        switch (fieldName) {
          case 'class':
            currentReq.class = value;
            break;
          case 'status':
            // Bullet status takes precedence over section heading
            currentReq.status = value;
            break;
          case 'description':
            currentReq.description = value;
            break;
          case 'why it matters':
          case 'why':
            currentReq.why = value;
            break;
          case 'source':
            currentReq.source = value;
            break;
          case 'primary owning slice':
          case 'primary owner':
          case 'primary_owner':
            currentReq.primary_owner = value;
            break;
          case 'supporting slices':
          case 'supporting_slices':
            currentReq.supporting_slices = value;
            break;
          case 'validation':
          case 'validated by':
            currentReq.validation = value;
            break;
          case 'notes':
            currentReq.notes = value;
            break;
          case 'proof':
            // In validated section, "Proof:" serves as notes
            currentReq.notes = value;
            break;
        }
      }
    }
  }

  flushReq();

  // Deduplicate by ID: if a requirement appears in both Active and Validated sections,
  // keep the fuller entry (typically Active) and merge in any non-empty fields from later entries.
  const deduped = new Map<string, Requirement>();
  for (const req of results) {
    const existing = deduped.get(req.id);
    if (!existing) {
      deduped.set(req.id, req);
    } else {
      // Merge: non-empty fields from later entry override empty fields in existing
      for (const key of Object.keys(req) as (keyof Requirement)[]) {
        if (key === 'id' || key === 'superseded_by') continue;
        const val = req[key];
        if (val && val !== '' && (!existing[key] || existing[key] === '')) {
          (existing as unknown as Record<string, unknown>)[key] = val;
        }
      }
    }
  }

  return Array.from(deduped.values());
}

// ─── Import Functions ──────────────────────────────────────────────────────

/**
 * Import decisions from DECISIONS.md into the database.
 * Handles supersession chains.
 */
function importDecisions(gsdDir: string): number {
  const filePath = resolveGsdRootFile(gsdDir, 'DECISIONS');
  if (!existsSync(filePath)) return 0;

  const content = readFileSync(filePath, 'utf-8');
  const decisions = parseDecisionsTable(content);

  for (const d of decisions) {
    upsertDecision(d);
  }

  return decisions.length;
}

/**
 * Import requirements from REQUIREMENTS.md into the database.
 */
function importRequirements(gsdDir: string): number {
  const filePath = resolveGsdRootFile(gsdDir, 'REQUIREMENTS');
  if (!existsSync(filePath)) return 0;

  const content = readFileSync(filePath, 'utf-8');
  const requirements = parseRequirementsSections(content);

  for (const r of requirements) {
    upsertRequirement(r);
  }

  return requirements.length;
}

// ─── Hierarchy Artifact Walker ─────────────────────────────────────────────

/** Artifact suffixes to look for at each hierarchy level */
const MILESTONE_SUFFIXES = ['ROADMAP', 'CONTEXT', 'RESEARCH', 'ASSESSMENT'];
const SLICE_SUFFIXES = ['PLAN', 'SUMMARY', 'RESEARCH', 'CONTEXT', 'ASSESSMENT', 'UAT'];
const TASK_SUFFIXES = ['PLAN', 'SUMMARY', 'CONTINUE', 'CONTEXT', 'RESEARCH'];

/**
 * Import hierarchy artifacts (roadmaps, plans, summaries, etc.) from the .gsd/ tree.
 * Walks milestones → slices → tasks directories.
 */
function importHierarchyArtifacts(gsdDir: string): number {
  let count = 0;
  const gsdPath = gsdRoot(gsdDir);

  // Root-level artifacts: PROJECT.md, QUEUE.md
  const rootFiles = ['PROJECT.md', 'QUEUE.md', 'SECRETS-MANIFEST.md'];
  for (const fileName of rootFiles) {
    const filePath = join(gsdPath, fileName);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const artifactType = fileName.replace('.md', '').replace('-', '_');
      insertArtifact({
        path: fileName,
        artifact_type: artifactType,
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: content,
      });
      count++;
    }
  }

  // Walk milestones
  const milestoneIds = findMilestoneIds(gsdDir);
  const msDir = milestonesDir(gsdDir);

  for (const milestoneId of milestoneIds) {
    // Find the actual milestone directory name (handles legacy naming)
    const milestoneDirName = findDirByPrefix(msDir, milestoneId);
    if (!milestoneDirName) continue;
    const milestoneFullPath = join(msDir, milestoneDirName);

    // Milestone-level files
    count += importFilesAtLevel(
      milestoneFullPath,
      milestoneId,
      MILESTONE_SUFFIXES,
      `milestones/${milestoneDirName}`,
      milestoneId,
      null,
      null,
    );

    // Walk slices
    const slicesDir = join(milestoneFullPath, 'slices');
    if (!existsSync(slicesDir)) continue;

    const sliceDirs = readdirSync(slicesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^S\d+/.test(d.name))
      .map(d => d.name)
      .sort();

    for (const sliceDirName of sliceDirs) {
      const sliceId = sliceDirName.match(/^(S\d+)/)?.[1] ?? sliceDirName;
      const sliceFullPath = join(slicesDir, sliceDirName);

      // Slice-level files
      count += importFilesAtLevel(
        sliceFullPath,
        sliceId,
        SLICE_SUFFIXES,
        `milestones/${milestoneDirName}/slices/${sliceDirName}`,
        milestoneId,
        sliceId,
        null,
      );

      // Walk tasks
      const tasksDir = join(sliceFullPath, 'tasks');
      if (!existsSync(tasksDir)) continue;

      for (const suffix of TASK_SUFFIXES) {
        const taskFiles = resolveTaskFiles(tasksDir, suffix);
        for (const taskFileName of taskFiles) {
          const taskId = taskFileName.match(/^(T\d+)/)?.[1] ?? null;
          const taskFilePath = join(tasksDir, taskFileName);
          if (!existsSync(taskFilePath)) continue;

          const content = readFileSync(taskFilePath, 'utf-8');
          const relPath = `milestones/${milestoneDirName}/slices/${sliceDirName}/tasks/${taskFileName}`;

          insertArtifact({
            path: relPath,
            artifact_type: suffix,
            milestone_id: milestoneId,
            slice_id: sliceId,
            task_id: taskId,
            full_content: content,
          });
          count++;
        }
      }
    }
  }

  return count;
}

/**
 * Import files at a specific hierarchy level (milestone or slice).
 */
function importFilesAtLevel(
  dirPath: string,
  idPrefix: string,
  suffixes: string[],
  relativeBase: string,
  milestoneId: string,
  sliceId: string | null,
  taskId: string | null,
): number {
  let count = 0;

  for (const suffix of suffixes) {
    // Try ID-SUFFIX.md pattern (e.g., M001-ROADMAP.md, S01-PLAN.md)
    const fileName = findFileByPrefixAndSuffix(dirPath, idPrefix, suffix);
    if (!fileName) continue;

    const filePath = join(dirPath, fileName);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const relPath = `${relativeBase}/${fileName}`;

    insertArtifact({
      path: relPath,
      artifact_type: suffix,
      milestone_id: milestoneId,
      slice_id: sliceId,
      task_id: taskId,
      full_content: content,
    });
    count++;
  }

  return count;
}

/**
 * Find a directory by ID prefix within a parent directory.
 */
function findDirByPrefix(parentDir: string, idPrefix: string): string | null {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    // Exact match first
    const exact = entries.find(e => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    // Prefix match for legacy
    const prefixed = entries.find(e => e.isDirectory() && e.name.startsWith(idPrefix + '-'));
    return prefixed ? prefixed.name : null;
  } catch {
    return null;
  }
}

/**
 * Find a file by ID prefix and suffix within a directory.
 * Matches ID-SUFFIX.md or ID-*-SUFFIX.md patterns.
 */
function findFileByPrefixAndSuffix(dir: string, idPrefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir);
    // Direct: ID-SUFFIX.md
    const target = `${idPrefix}-${suffix}.md`.toUpperCase();
    const direct = entries.find(e => e.toUpperCase() === target);
    if (direct) return direct;
    // Legacy: ID-DESCRIPTOR-SUFFIX.md
    const pattern = new RegExp(`^${idPrefix}-.*-${suffix}\\.md$`, 'i');
    const match = entries.find(e => pattern.test(e));
    return match ?? null;
  } catch {
    return null;
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Import all markdown artifacts from a .gsd/ directory into the database.
 * Opens the DB if not already open. Wraps all imports in a single transaction.
 * Returns counts of imported items for logging.
 *
 * Missing files are skipped gracefully — no errors produced.
 */
export function migrateFromMarkdown(gsdDir: string): {
  decisions: number;
  requirements: number;
  artifacts: number;
} {
  const dbPath = join(gsdRoot(gsdDir), 'gsd.db');

  // Open DB if not already open
  if (!_getAdapter()) {
    openDatabase(dbPath);
  }

  let decisions = 0;
  let requirements = 0;
  let artifacts = 0;

  transaction(() => {
    try {
      decisions = importDecisions(gsdDir);
    } catch (err) {
      process.stderr.write(`gsd-migrate: skipping decisions import: ${(err as Error).message}\n`);
    }

    try {
      requirements = importRequirements(gsdDir);
    } catch (err) {
      process.stderr.write(`gsd-migrate: skipping requirements import: ${(err as Error).message}\n`);
    }

    try {
      artifacts = importHierarchyArtifacts(gsdDir);
    } catch (err) {
      process.stderr.write(`gsd-migrate: skipping artifacts import: ${(err as Error).message}\n`);
    }
  });

  process.stderr.write(
    `gsd-migrate: imported ${decisions} decisions, ${requirements} requirements, ${artifacts} artifacts\n`,
  );

  return { decisions, requirements, artifacts };
}
