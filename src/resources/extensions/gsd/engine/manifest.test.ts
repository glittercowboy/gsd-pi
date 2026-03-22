// GSD Extension — State Manifest Unit Tests
// Tests for snapshot, restore, writeManifest, bootstrapFromManifest functions.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import type { DbAdapter } from "../gsd-db.ts";
import { snapshot, restore, writeManifest, bootstrapFromManifest } from "../workflow-manifest.ts";
import type { StateManifest } from "../workflow-manifest.ts";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Helper: seed a test DB with one milestone, one slice, two tasks, one decision, one evidence.
 */
function seedTestData(db: DbAdapter): void {
  db.prepare(
    `INSERT INTO milestones (id, title, status, created_at)
     VALUES ('M001', 'Test Milestone', 'active', '2026-01-01T00:00:00Z')`,
  ).run();

  db.prepare(
    `INSERT INTO slices (id, milestone_id, title, status, risk, depends_on, created_at, seq)
     VALUES ('S01', 'M001', 'Test Slice', 'active', 'low', '[]', '2026-01-01T00:00:00Z', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
     VALUES ('T01', 'S01', 'M001', 'Task One', 'Do thing one', 'done', '1h', '["a.ts"]', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
     VALUES ('T02', 'S01', 'M001', 'Task Two', 'Do thing two', 'pending', '2h', '[]', 1)`,
  ).run();

  db.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
     VALUES ('D001', 'during planning', 'schema', 'Use SQLite', 'SQLite', 'Best fit', 'yes', 'agent', NULL)`,
  ).run();

  db.prepare(
    `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, stdout, stderr, duration_ms, recorded_at)
     VALUES ('T01', 'S01', 'M001', 'npm test', 0, 'ok', '', 150, '2026-01-01T01:00:00Z')`,
  ).run();
}

describe("workflow-manifest", () => {
  let db: DbAdapter;

  beforeEach(() => {
    openDatabase(":memory:");
    db = _getAdapter()!;
    assert.ok(db, "DB adapter must be available");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("snapshot()", () => {
    it("returns object with version=1, exported_at, and all entity arrays from populated DB", () => {
      seedTestData(db);
      const snap = snapshot(db);

      assert.equal(snap.version, 1);
      assert.ok(snap.exported_at, "exported_at must be present");
      assert.ok(new Date(snap.exported_at).getTime() > 0, "exported_at must be valid ISO date");
      assert.equal(snap.milestones.length, 1);
      assert.equal(snap.slices.length, 1);
      assert.equal(snap.tasks.length, 2);
      assert.equal(snap.decisions.length, 1);
      assert.equal(snap.verification_evidence.length, 1);

      // Verify data fidelity
      assert.equal(snap.milestones[0]!.id, "M001");
      assert.equal(snap.tasks[0]!.title, "Task One");
      assert.equal(snap.decisions[0]!.choice, "SQLite");
      assert.equal(snap.verification_evidence[0]!.command, "npm test");
    });

    it("returns object with empty arrays for empty DB", () => {
      const snap = snapshot(db);
      assert.equal(snap.version, 1);
      assert.ok(snap.exported_at);
      assert.equal(snap.milestones.length, 0);
      assert.equal(snap.slices.length, 0);
      assert.equal(snap.tasks.length, 0);
      assert.equal(snap.decisions.length, 0);
      assert.equal(snap.verification_evidence.length, 0);
    });
  });

  describe("restore()", () => {
    it("populates all tables correctly on empty DB", () => {
      seedTestData(db);
      const snap = snapshot(db);

      // Clear all tables
      db.exec("DELETE FROM verification_evidence");
      db.exec("DELETE FROM tasks");
      db.exec("DELETE FROM slices");
      db.exec("DELETE FROM milestones");
      db.exec("DELETE FROM decisions");

      restore(db, snap);

      // Verify all restored
      const milestones = db.prepare("SELECT * FROM milestones").all();
      assert.equal(milestones.length, 1);
      const tasks = db.prepare("SELECT * FROM tasks").all();
      assert.equal(tasks.length, 2);
      const decisions = db.prepare("SELECT * FROM decisions").all();
      assert.equal(decisions.length, 1);
      const evidence = db.prepare("SELECT * FROM verification_evidence").all();
      assert.equal(evidence.length, 1);
    });

    it("replaces all existing data on populated DB", () => {
      seedTestData(db);

      // Create a different manifest
      const manifest: StateManifest = {
        version: 1,
        exported_at: new Date().toISOString(),
        milestones: [{ id: "M999", title: "New Milestone", status: "active", created_at: "2026-02-01T00:00:00Z", completed_at: null }],
        slices: [],
        tasks: [],
        decisions: [],
        verification_evidence: [],
      };

      restore(db, manifest);

      const milestones = db.prepare("SELECT * FROM milestones").all();
      assert.equal(milestones.length, 1);
      assert.equal(milestones[0]!["id"], "M999");

      const tasks = db.prepare("SELECT * FROM tasks").all();
      assert.equal(tasks.length, 0);
    });

    it("is atomic — if one insert fails, no tables are modified", () => {
      seedTestData(db);
      const originalSnap = snapshot(db);

      // Create a manifest with bad data that will fail (duplicate PK within manifest)
      const badManifest: StateManifest = {
        version: 1,
        exported_at: new Date().toISOString(),
        milestones: [
          { id: "M100", title: "A", status: "active", created_at: "2026-01-01T00:00:00Z", completed_at: null },
          { id: "M100", title: "B", status: "active", created_at: "2026-01-01T00:00:00Z", completed_at: null }, // Duplicate!
        ],
        slices: [],
        tasks: [],
        decisions: [],
        verification_evidence: [],
      };

      assert.throws(() => restore(db, badManifest));

      // Original data should still be intact
      const milestones = db.prepare("SELECT * FROM milestones").all();
      assert.equal(milestones.length, originalSnap.milestones.length);
      assert.equal(milestones[0]!["id"], "M001");
    });
  });

  describe("writeManifest()", () => {
    it("writes state-manifest.json to .gsd/ directory", () => {
      seedTestData(db);
      const tempDir = mkdtempSync(join(tmpdir(), "gsd-manifest-test-"));

      try {
        writeManifest(tempDir, db);

        const manifestPath = join(tempDir, ".gsd", "state-manifest.json");
        assert.ok(existsSync(manifestPath), "state-manifest.json must exist");

        const content = readFileSync(manifestPath, "utf-8");
        const parsed = JSON.parse(content) as StateManifest;
        assert.equal(parsed.version, 1);
        assert.equal(parsed.milestones.length, 1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("produces pretty-printed JSON with 2-space indent", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "gsd-manifest-test-"));

      try {
        writeManifest(tempDir, db);

        const content = readFileSync(join(tempDir, ".gsd", "state-manifest.json"), "utf-8");
        // Pretty-printed JSON starts with {\n  "version"
        assert.ok(content.includes('  "version"'), "must be 2-space indented");
        assert.ok(content.includes("\n"), "must have newlines");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("bootstrapFromManifest()", () => {
    it("reads state-manifest.json and restores DB state", () => {
      seedTestData(db);
      const tempDir = mkdtempSync(join(tmpdir(), "gsd-manifest-test-"));

      try {
        writeManifest(tempDir, db);

        // Clear all engine tables
        db.exec("DELETE FROM verification_evidence");
        db.exec("DELETE FROM tasks");
        db.exec("DELETE FROM slices");
        db.exec("DELETE FROM milestones");
        db.exec("DELETE FROM decisions");

        const result = bootstrapFromManifest(tempDir, db);
        assert.equal(result, true);

        const milestones = db.prepare("SELECT * FROM milestones").all();
        assert.equal(milestones.length, 1);
        assert.equal(milestones[0]!["id"], "M001");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns false when manifest file does not exist", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "gsd-manifest-test-"));

      try {
        const result = bootstrapFromManifest(tempDir, db);
        assert.equal(result, false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
