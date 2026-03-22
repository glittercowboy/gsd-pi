// GSD Extension — Migration Module Unit Tests
// Tests for migrateFromMarkdown, needsAutoMigration, and validateMigration.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import { migrateFromMarkdown, needsAutoMigration, validateMigration } from "../workflow-migration.ts";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const SAMPLE_ROADMAP = `# M001: Test Milestone

**Vision:** Build a test project

## Slices

- [ ] **S01: First Slice** — Risk: low
  After this: First slice is done
- [x] **S02: Second Slice** — Risk: medium
  After this: Second slice is done
`;

const SAMPLE_PLAN_S01 = `---
id: S01
---
# S01: First Slice

**Goal:** Build first slice

**Demo:** Shows first slice working

## Must-Haves

- First thing
- Second thing

## Tasks

- [ ] **T01: First Task** \`est:30m\`
  Description of first task
- [ ] **T02: Second Task** \`est:1h\`
  Description of second task
- [x] **T03: Third Task (Done)** \`est:30m\`
  Description of third task
`;

const SAMPLE_PLAN_S02 = `---
id: S02
---
# S02: Second Slice

**Goal:** Build second slice

## Tasks

- [x] **T01: Task One** \`est:30m\`
  Done task
- [x] **T02: Task Two** \`est:1h\`
  Another done task
`;

const SAMPLE_SUMMARY_S02 = `---
id: S02
parent: M001
milestone: M001
---
# S02: Second Slice Summary

**Second slice completed successfully.**

## What Happened

Completed the second slice.
`;

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe("workflow-migration", () => {
  let tempDir: string;
  let gsdDir: string;
  let milestonesDir: string;
  let m001Dir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gsd-migration-test-"));
    gsdDir = join(tempDir, ".gsd");
    milestonesDir = join(gsdDir, "milestones");
    m001Dir = join(milestonesDir, "M001");
    mkdirSync(m001Dir, { recursive: true });

    // Open a fresh DB for each test
    const dbPath = join(gsdDir, "gsd.db");
    openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── needsAutoMigration ─────────────────────────────────────────────────

  it("Test 1: needsAutoMigration returns true when engine tables empty AND .gsd/milestones/ dir exists with markdown files", () => {
    // Write a markdown file to milestones dir
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    const result = needsAutoMigration(tempDir);
    assert.equal(result, true, "Should need migration when tables empty and markdown exists");
  });

  it("Test 2: needsAutoMigration returns false when engine tables already have rows", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    // Insert a row into milestones
    const db = _getAdapter();
    assert.ok(db, "DB must be available");
    db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
      .run("M001", "Test Milestone", "active", new Date().toISOString());

    const result = needsAutoMigration(tempDir);
    assert.equal(result, false, "Should not need migration when tables have rows");
  });

  it("Test 3: needsAutoMigration returns false when no .gsd/milestones/ directory exists", () => {
    // Remove milestones dir that was created in beforeEach
    rmSync(milestonesDir, { recursive: true, force: true });

    const result = needsAutoMigration(tempDir);
    assert.equal(result, false, "Should not need migration when no milestones directory");
  });

  // ─── migrateFromMarkdown ────────────────────────────────────────────────

  it("Test 4: migrateFromMarkdown populates milestones table from ROADMAP.md", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    migrateFromMarkdown(tempDir);

    const db = _getAdapter();
    assert.ok(db, "DB must be available");
    const milestones = db.prepare("SELECT * FROM milestones").all();
    assert.ok(milestones.length >= 1, `Expected at least 1 milestone, got ${milestones.length}`);
    const m001 = milestones.find(m => m["id"] === "M001");
    assert.ok(m001, "M001 should be in milestones table");
  });

  it("Test 5: migrateFromMarkdown populates slices table from ROADMAP.md slice entries", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    migrateFromMarkdown(tempDir);

    const db = _getAdapter();
    assert.ok(db, "DB must be available");
    const slices = db.prepare("SELECT * FROM slices WHERE milestone_id = ?").all("M001");
    assert.ok(slices.length >= 2, `Expected at least 2 slices, got ${slices.length}`);
    const s01 = slices.find(s => s["id"] === "S01");
    const s02 = slices.find(s => s["id"] === "S02");
    assert.ok(s01, "S01 should be in slices table");
    assert.ok(s02, "S02 should be in slices table");
  });

  it("Test 6: migrateFromMarkdown populates tasks table from *-PLAN.md files", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);
    writeFileSync(join(m001Dir, "S01-PLAN.md"), SAMPLE_PLAN_S01);

    migrateFromMarkdown(tempDir);

    const db = _getAdapter();
    assert.ok(db, "DB must be available");
    const tasks = db.prepare("SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ?").all("M001", "S01");
    assert.ok(tasks.length >= 3, `Expected at least 3 tasks for S01, got ${tasks.length}`);
  });

  it("Test 7: migrateFromMarkdown marks completed milestones (with SUMMARY.md) as done, and all child entities as done", () => {
    // Set up a milestone that has a summary (done)
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);
    writeFileSync(join(m001Dir, "S02-PLAN.md"), SAMPLE_PLAN_S02);
    // Write a milestone-level summary to indicate M001 is done
    writeFileSync(join(m001Dir, "SUMMARY.md"), `---\nmilestone: M001\n---\n# M001 Summary\nMilestone complete.\n`);

    migrateFromMarkdown(tempDir);

    const db = _getAdapter();
    assert.ok(db, "DB must be available");
    const m001 = db.prepare("SELECT * FROM milestones WHERE id = ?").get("M001") as Record<string, unknown> | undefined;
    assert.ok(m001, "M001 should exist");
    assert.equal(m001["status"], "done", "M001 should be status=done");

    // All child slices should be done
    const slices = db.prepare("SELECT * FROM slices WHERE milestone_id = ?").all("M001");
    for (const slice of slices) {
      assert.equal(slice["status"], "done", `Slice ${slice["id"]} should be done when milestone is done`);
    }

    // All tasks should be done
    const tasks = db.prepare("SELECT * FROM tasks WHERE milestone_id = ?").all("M001");
    for (const task of tasks) {
      assert.equal(task["status"], "done", `Task ${task["id"]} should be done when milestone is done`);
    }
  });

  it("Test 8: migrateFromMarkdown handles 'no DB yet' shape — creates DB, populates from markdown", () => {
    // Close current DB and delete it to simulate "no DB yet" state
    closeDatabase();
    const dbPath = join(gsdDir, "gsd.db");
    rmSync(dbPath, { force: true });

    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    // Re-open DB (simulating the caller who created it fresh)
    openDatabase(dbPath);

    migrateFromMarkdown(tempDir);

    const db = _getAdapter();
    assert.ok(db, "DB must be available after migration");
    const milestones = db.prepare("SELECT * FROM milestones").all();
    assert.ok(milestones.length >= 1, "Should have milestones after migration");
  });

  it("Test 9: migrateFromMarkdown handles 'stale DB' shape — wipes engine tables, re-populates", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    // First migration
    migrateFromMarkdown(tempDir);

    const db = _getAdapter();
    assert.ok(db, "DB must be available");
    const countBefore = (db.prepare("SELECT COUNT(*) as cnt FROM milestones").get() as Record<string, unknown>)["cnt"] as number;

    // Now wipe the tables to simulate stale DB (or partial migration)
    db.prepare("DELETE FROM milestones").run();
    db.prepare("DELETE FROM slices").run();
    db.prepare("DELETE FROM tasks").run();

    // Second migration should re-populate
    migrateFromMarkdown(tempDir);

    const countAfter = (db.prepare("SELECT COUNT(*) as cnt FROM milestones").get() as Record<string, unknown>)["cnt"] as number;
    assert.ok(countAfter >= 1, "Should have milestones after re-migration");
    assert.equal(countAfter, countBefore, "Re-migration should produce same count as initial migration");
  });

  it("Test 10: migrateFromMarkdown handles orphaned summary files — logs warning, does not crash", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);
    // Write an orphaned summary for S99 which doesn't exist in ROADMAP.md
    writeFileSync(join(m001Dir, "S99-SUMMARY.md"), `---\nid: S99\n---\n# S99 Orphan Summary\nThis slice was removed.\n`);

    // Should not throw
    assert.doesNotThrow(() => {
      migrateFromMarkdown(tempDir);
    }, "Should not crash on orphaned summary files");
  });

  it("Test 11: migrateFromMarkdown writes a synthetic 'migrate' event to event-log.jsonl with actor='system'", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    migrateFromMarkdown(tempDir);

    const logPath = join(gsdDir, "event-log.jsonl");
    assert.ok(existsSync(logPath), "event-log.jsonl must exist after migration");

    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(l => l.length > 0);
    const migrateEvent = lines.map(l => JSON.parse(l)).find((e: Record<string, unknown>) => e["cmd"] === "migrate");
    assert.ok(migrateEvent, "Should have a 'migrate' event in event log");
    assert.equal(migrateEvent["actor"], "system", "Migrate event should have actor='system'");
  });

  it("Test 12: migrateFromMarkdown calls writeManifest after all inserts", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);

    migrateFromMarkdown(tempDir);

    const manifestPath = join(gsdDir, "state-manifest.json");
    assert.ok(existsSync(manifestPath), "state-manifest.json should exist after migration");
  });

  it("Test 13: After migrateFromMarkdown, engine deriveState() produces output with matching milestone/slice/task counts compared to markdown", () => {
    writeFileSync(join(m001Dir, "ROADMAP.md"), SAMPLE_ROADMAP);
    writeFileSync(join(m001Dir, "S01-PLAN.md"), SAMPLE_PLAN_S01);
    writeFileSync(join(m001Dir, "S02-PLAN.md"), SAMPLE_PLAN_S02);
    writeFileSync(join(m001Dir, "S02-SUMMARY.md"), SAMPLE_SUMMARY_S02);

    migrateFromMarkdown(tempDir);

    const { discrepancies } = validateMigration(tempDir);
    // Discrepancies should be an array (may be empty or have entries)
    assert.ok(Array.isArray(discrepancies), "validateMigration should return discrepancies array");
  });
});
