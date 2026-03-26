/**
 * Regression test for #2694: parkMilestone and unparkMilestone must
 * update the DB milestone status alongside the filesystem marker.
 *
 * Without this, deriveStateFromDb skips unparked milestones because
 * the DB still has status='parked', causing "All milestones complete".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parkMilestone, unparkMilestone } from "../milestone-actions.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  getMilestone,
} from "../gsd-db.ts";

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-park-db-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001\n\nContext.",
  );
  return base;
}

test("parkMilestone updates DB status to 'parked' (#2694)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    assert.equal(getMilestone("M001")!.status, "active", "starts active");

    parkMilestone(base, "M001", "deprioritized");

    assert.equal(getMilestone("M001")!.status, "parked", "DB status should be parked");

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("unparkMilestone updates DB status to 'active' (#2694)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    // Park first
    parkMilestone(base, "M001", "deprioritized");
    assert.equal(getMilestone("M001")!.status, "parked");

    // Unpark
    unparkMilestone(base, "M001");
    assert.equal(getMilestone("M001")!.status, "active", "DB status should be active after unpark");

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("park/unpark are safe when DB is not available (#2694 guard)", () => {
  const base = createBase();
  try {
    // No openDatabase — DB not available
    // park/unpark should still work (filesystem-only, no throw)
    const parked = parkMilestone(base, "M001", "test");
    assert.ok(parked, "parkMilestone succeeds without DB");

    const unparked = unparkMilestone(base, "M001");
    assert.ok(unparked, "unparkMilestone succeeds without DB");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
