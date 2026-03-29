/**
 * Regression test for #2985 Bug 2: state.ts DB writes hidden inside read functions.
 *
 * deriveState() and deriveStateFromDb() must not write to the DB as a side
 * effect.  Disk-to-DB reconciliation must be an explicit operation that callers
 * invoke before querying state.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState, invalidateStateCache, deriveStateFromDb } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  getAllMilestones,
  isDbAvailable,
} from "../gsd-db.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-cqs-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("#2985 Bug 2 — deriveState must not write to DB", () => {
  let base: string;

  beforeEach(() => {
    base = createFixtureBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
  });

  afterEach(() => {
    closeDatabase();
    cleanup(base);
    invalidateStateCache();
  });

  test("deriveStateFromDb does not insert milestones that only exist on disk", async () => {
    // Create a milestone directory on disk but NOT in DB
    const milestoneId = "M001-abc123";
    writeFile(base, `milestones/${milestoneId}/${milestoneId}-CONTEXT.md`, "# M001: Test\n\nContent here.");

    // DB should have zero milestones
    const before = getAllMilestones();
    assert.equal(before.length, 0, "DB should start empty");

    // deriveStateFromDb is a READ function — it should NOT write to DB
    await deriveStateFromDb(base);

    const after = getAllMilestones();
    assert.equal(after.length, 0,
      "deriveStateFromDb must not insert milestones into the DB — it is a read function");
  });

  test("deriveState does not insert milestones that only exist on disk", async () => {
    // Create a milestone directory on disk but NOT in DB
    const milestoneId = "M001-abc123";
    writeFile(base, `milestones/${milestoneId}/${milestoneId}-CONTEXT.md`, "# M001: Test\n\nContent here.");

    const before = getAllMilestones();
    assert.equal(before.length, 0, "DB should start empty");

    await deriveState(base);

    const after = getAllMilestones();
    assert.equal(after.length, 0,
      "deriveState must not insert milestones into the DB — it is a read function");
  });
});
