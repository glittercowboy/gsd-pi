// GSD Extension — Legacy Markdown to Engine Migration
// Converts legacy markdown-only projects to engine state by parsing
// existing ROADMAP.md, *-PLAN.md, and *-SUMMARY.md files.
// Populates data into the already-existing v10 schema tables.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _getAdapter, transaction } from "./gsd-db.js";
import { parseRoadmap, parsePlan } from "./parsers-legacy.js";
import { logWarning } from "./workflow-logger.js";

// ─── needsAutoMigration ───────────────────────────────────────────────────

/**
 * Returns true when engine tables are empty AND a .gsd/milestones/ directory
 * with markdown files exists — signals that this is a legacy project that needs
 * one-time migration from markdown to engine state.
 */
export function needsAutoMigration(basePath: string): boolean {
  const db = _getAdapter();
  if (!db) return false;

  // If milestones table already has rows, migration already done
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM milestones").get();
    if (row && (row["cnt"] as number) > 0) return false;
  } catch (e) {
    logWarning("migration", `DB probe failed: ${(e as Error).message}`);
    return false;
  }

  // Check if .gsd/milestones/ directory exists
  const milestonesDir = join(basePath, ".gsd", "milestones");
  if (!existsSync(milestonesDir)) return false;

  return true;
}

// ─── migrateFromMarkdown ──────────────────────────────────────────────────

/**
 * Migrate legacy markdown-only .gsd/ projects to engine DB state.
 * Reads .gsd/milestones/<ID>/ directories and parses ROADMAP.md, *-PLAN.md
 * files. All inserts are wrapped in a transaction.
 *
 * This function only INSERTs data into the already-existing v10 schema tables
 * (milestones, slices, tasks). It does NOT create tables or run migrations.
 *
 * Handles all directory shapes:
 * - No DB: caller is responsible for openDatabase + initSchema before calling
 * - Stale DB (empty tables): inserts succeed normally
 * - No markdown at all: returns early with stderr message
 * - Orphaned summary files: logs warning, skips without crash
 */
export function migrateFromMarkdown(basePath: string): void {
  const db = _getAdapter();
  if (!db) {
    process.stderr.write("workflow-migration: no database connection, cannot migrate\n");
    return;
  }

  const milestonesDir = join(basePath, ".gsd", "milestones");
  if (!existsSync(milestonesDir)) {
    process.stderr.write("workflow-migration: no .gsd/milestones/ directory found, nothing to migrate\n");
    return;
  }

  // Discover milestone directories (any directory at the top level of milestones/)
  let milestoneDirs: string[];
  try {
    milestoneDirs = readdirSync(milestonesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    logWarning("migration", "failed to read milestones directory");
    return;
  }

  if (milestoneDirs.length === 0) {
    process.stderr.write("workflow-migration: no milestone directories found in .gsd/milestones/\n");
    return;
  }

  // Collect all data before the transaction
  const migratedMilestoneIds: string[] = [];

  interface MilestoneInsert {
    id: string;
    title: string;
    status: string;
  }

  interface SliceInsert {
    id: string;
    milestoneId: string;
    title: string;
    status: string;
    risk: string;
    sequence: number;
    forceDone: boolean;
  }

  interface TaskInsert {
    id: string;
    sliceId: string;
    milestoneId: string;
    title: string;
    status: string;
    sequence: number;
  }

  const milestoneInserts: MilestoneInsert[] = [];
  const sliceInserts: SliceInsert[] = [];
  const taskInserts: TaskInsert[] = [];

  for (const mId of milestoneDirs) {
    const mDir = join(milestonesDir, mId);

    // Determine milestone status: done if a milestone-level SUMMARY.md exists
    const milestoneSummaryPath = join(mDir, "SUMMARY.md");
    const milestoneDone = existsSync(milestoneSummaryPath);
    const milestoneStatus = milestoneDone ? "done" : "active";

    // Parse ROADMAP.md for slices list
    const roadmapPath = join(mDir, "ROADMAP.md");
    let roadmapSlices: Array<{ id: string; title: string; done: boolean; risk: string }> = [];

    if (existsSync(roadmapPath)) {
      try {
        const roadmapContent = readFileSync(roadmapPath, "utf-8");
        const roadmap = parseRoadmap(roadmapContent);

        // Extract milestone title from roadmap
        const mTitle = roadmap.title || mId;

        milestoneInserts.push({ id: mId, title: mTitle, status: milestoneStatus });

        roadmapSlices = roadmap.slices.map(s => ({
          id: s.id,
          title: s.title,
          done: s.done,
          risk: s.risk || "low",
        }));
      } catch (err) {
        logWarning("migration", `failed to parse ROADMAP.md for ${mId}: ${(err as Error).message}`);
        // Still add milestone with ID as title
        milestoneInserts.push({ id: mId, title: mId, status: milestoneStatus });
      }
    } else {
      // No ROADMAP.md — add milestone entry anyway using directory name
      milestoneInserts.push({ id: mId, title: mId, status: milestoneStatus });
    }

    migratedMilestoneIds.push(mId);

    // Collect slices from ROADMAP + their tasks from PLAN files
    const knownSliceIds = new Set(roadmapSlices.map(s => s.id));

    for (let sIdx = 0; sIdx < roadmapSlices.length; sIdx++) {
      const slice = roadmapSlices[sIdx];
      // Per Pitfall #5: if milestone is done, force all child slices to done
      const sliceStatus = milestoneDone ? "done" : (slice.done ? "done" : "pending");

      sliceInserts.push({
        id: slice.id,
        milestoneId: mId,
        title: slice.title,
        status: sliceStatus,
        risk: slice.risk,
        sequence: sIdx,
        forceDone: milestoneDone,
      });

      // Read *-PLAN.md for this slice
      const planPath = join(mDir, `${slice.id}-PLAN.md`);
      if (existsSync(planPath)) {
        try {
          const planContent = readFileSync(planPath, "utf-8");
          const plan = parsePlan(planContent);

          for (let tIdx = 0; tIdx < plan.tasks.length; tIdx++) {
            const task = plan.tasks[tIdx];
            // Per Pitfall #5: if milestone is done, force all tasks to done
            const taskStatus = milestoneDone ? "done" : (task.done ? "done" : "pending");
            taskInserts.push({
              id: task.id,
              sliceId: slice.id,
              milestoneId: mId,
              title: task.title,
              status: taskStatus,
              sequence: tIdx,
            });
          }
        } catch (err) {
          logWarning("migration", `failed to parse ${slice.id}-PLAN.md for ${mId}: ${(err as Error).message}`);
        }
      }
    }

    // Check for orphaned summary files (summary for a slice not in ROADMAP)
    try {
      const files = readdirSync(mDir);
      const summaryFiles = files.filter(f => f.endsWith("-SUMMARY.md") && f !== "SUMMARY.md");
      for (const summaryFile of summaryFiles) {
        const sliceId = summaryFile.replace("-SUMMARY.md", "");
        if (!knownSliceIds.has(sliceId)) {
          process.stderr.write(`workflow-migration: orphaned summary file ${summaryFile} in ${mId} (slice not found in ROADMAP.md), skipping\n`);
        }
      }
    } catch (e) {
      logWarning("migration", `Orphaned summary check failed for ${mId}: ${(e as Error).message}`);
    }
  }

  // Execute all inserts atomically
  const now = new Date().toISOString();
  if (migratedMilestoneIds.length === 0) {
    process.stderr.write("workflow-migration: no milestones collected, nothing to insert\n");
    return;
  }

  const placeholders = migratedMilestoneIds.map(() => "?").join(",");
  transaction(() => {
    // Clear existing data to handle stale DB shape (DELETE ... IN (...))
    db.prepare(`DELETE FROM tasks WHERE milestone_id IN (${placeholders})`).run(...migratedMilestoneIds);
    db.prepare(`DELETE FROM slices WHERE milestone_id IN (${placeholders})`).run(...migratedMilestoneIds);
    db.prepare(`DELETE FROM milestones WHERE id IN (${placeholders})`).run(...migratedMilestoneIds);

    // Insert milestones
    const insertMilestone = db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)");
    for (const m of milestoneInserts) {
      insertMilestone.run(m.id, m.title, m.status, now);
    }

    // Insert slices (using v10 column names: depends, sequence)
    const insertSlice = db.prepare(
      "INSERT INTO slices (id, milestone_id, title, status, risk, depends, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const s of sliceInserts) {
      insertSlice.run(s.id, s.milestoneId, s.title, s.status, s.risk, "[]", s.sequence, now);
    }

    // Insert tasks (using v10 column names: sequence, blocker_discovered, full_summary_md)
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const t of taskInserts) {
      insertTask.run(t.id, t.sliceId, t.milestoneId, t.title, "", t.status, "", "[]", t.sequence);
    }
  });
}

// ─── validateMigration ────────────────────────────────────────────────────

/**
 * D-14: Validate that engine state matches what markdown parsers report.
 * Compares milestone count, slice count, task count, and status distributions.
 * Logs each discrepancy to stderr but does NOT throw.
 * Returns array of discrepancy strings (empty = clean migration).
 */
export function validateMigration(basePath: string): { discrepancies: string[] } {
  const db = _getAdapter();
  if (!db) {
    return { discrepancies: ["No database connection for validation"] };
  }

  const discrepancies: string[] = [];

  // Get engine counts
  const engMilestones = db.prepare("SELECT COUNT(*) as cnt FROM milestones").get();
  const engSlices = db.prepare("SELECT COUNT(*) as cnt FROM slices").get();
  const engTasks = db.prepare("SELECT COUNT(*) as cnt FROM tasks").get();

  const engineMilestoneCount = engMilestones ? (engMilestones["cnt"] as number) : 0;
  const engineSliceCount = engSlices ? (engSlices["cnt"] as number) : 0;
  const engineTaskCount = engTasks ? (engTasks["cnt"] as number) : 0;

  // Count from markdown
  const milestonesDir = join(basePath, ".gsd", "milestones");
  if (!existsSync(milestonesDir)) {
    return { discrepancies };
  }

  let mdMilestoneCount = 0;
  let mdSliceCount = 0;
  let mdTaskCount = 0;

  try {
    const milestoneDirs = readdirSync(milestonesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    mdMilestoneCount = milestoneDirs.length;

    for (const mId of milestoneDirs) {
      const mDir = join(milestonesDir, mId);
      const roadmapPath = join(mDir, "ROADMAP.md");

      if (existsSync(roadmapPath)) {
        try {
          const content = readFileSync(roadmapPath, "utf-8");
          const roadmap = parseRoadmap(content);
          mdSliceCount += roadmap.slices.length;

          for (const slice of roadmap.slices) {
            const planPath = join(mDir, `${slice.id}-PLAN.md`);
            if (existsSync(planPath)) {
              try {
                const planContent = readFileSync(planPath, "utf-8");
                const plan = parsePlan(planContent);
                mdTaskCount += plan.tasks.length;
              } catch (e) {
                logWarning("migration", `Failed to read plan ${slice.id}-PLAN.md: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          logWarning("migration", `Failed to read roadmap for ${mId}: ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    logWarning("migration", `Validation failed to read markdown: ${(e as Error).message}`);
    return { discrepancies: ["Failed to read markdown for validation"] };
  }

  // Compare counts
  if (engineMilestoneCount !== mdMilestoneCount) {
    const msg = `Milestone count mismatch: engine=${engineMilestoneCount}, markdown=${mdMilestoneCount}`;
    discrepancies.push(msg);
    process.stderr.write(`workflow-migration: ${msg}\n`);
  }

  if (engineSliceCount !== mdSliceCount) {
    const msg = `Slice count mismatch: engine=${engineSliceCount}, markdown=${mdSliceCount}`;
    discrepancies.push(msg);
    process.stderr.write(`workflow-migration: ${msg}\n`);
  }

  if (engineTaskCount !== mdTaskCount) {
    const msg = `Task count mismatch: engine=${engineTaskCount}, markdown=${mdTaskCount}`;
    discrepancies.push(msg);
    process.stderr.write(`workflow-migration: ${msg}\n`);
  }

  return { discrepancies };
}
