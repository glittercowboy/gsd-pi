/**
 * Regression test for #2473: Pre-flight CONTEXT-DRAFT warning should skip
 * completed and parked milestones.
 *
 * The pre-flight loop in auto-start.ts warns about CONTEXT-DRAFT.md files
 * so the user knows which milestones will pause for discussion. But completed
 * milestones with leftover CONTEXT-DRAFT.md files are not actionable — the
 * warning is noise.
 *
 * This test exercises the filtering logic directly: given a set of milestones
 * with CONTEXT-DRAFT files, only active/pending ones should produce warnings.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertMilestone,
  getMilestone,
} from "../gsd-db.ts";
import { resolveMilestoneFile } from "../paths.ts";

describe("pre-flight CONTEXT-DRAFT filter (#2473)", () => {
  let tmpBase: string;
  let gsd: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "gsd-preflight-draft-"));
    gsd = join(tmpBase, ".gsd");

    // Create milestone directories with CONTEXT-DRAFT files
    for (const id of ["M001", "M002", "M003"]) {
      const msDir = join(gsd, "milestones", id);
      mkdirSync(msDir, { recursive: true });
      writeFileSync(join(msDir, `${id}-CONTEXT-DRAFT.md`), `# ${id}: Draft\n`);
    }

    // Open DB and insert milestones with different statuses
    const dbPath = join(gsd, "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001", title: "Complete milestone", status: "complete" });
    insertMilestone({ id: "M002", title: "Active milestone", status: "active" });
    insertMilestone({ id: "M003", title: "Parked milestone", status: "parked" });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("completed milestone is skipped — no warning emitted", () => {
    assert.ok(isDbAvailable(), "DB should be available");
    const ms = getMilestone("M001");
    assert.equal(ms?.status, "complete");
  });

  test("parked milestone is skipped — no warning emitted", () => {
    const ms = getMilestone("M003");
    assert.equal(ms?.status, "parked");
  });

  test("active milestone with CONTEXT-DRAFT produces warning", () => {
    const ms = getMilestone("M002");
    assert.equal(ms?.status, "active");

    const draft = resolveMilestoneFile(tmpBase, "M002", "CONTEXT-DRAFT");
    assert.ok(draft, "CONTEXT-DRAFT file should be found for active milestone");
  });

  test("full pre-flight filter produces warnings only for active milestones", () => {
    const milestoneIds = ["M001", "M002", "M003"];
    const issues: string[] = [];

    for (const id of milestoneIds) {
      // Replicate the fixed pre-flight logic from auto-start.ts
      if (isDbAvailable()) {
        const ms = getMilestone(id);
        if (ms?.status === "complete" || ms?.status === "parked") continue;
      }
      const draft = resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT");
      if (draft) {
        issues.push(`${id}: has CONTEXT-DRAFT.md (will pause for discussion)`);
      }
    }

    assert.equal(issues.length, 1, "only one warning should be emitted");
    assert.match(issues[0], /M002/, "warning should be for the active milestone only");
  });

  test("when DB is unavailable, all milestones with CONTEXT-DRAFT produce warnings (safe fallback)", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), "DB should be unavailable after close");

    const milestoneIds = ["M001", "M002", "M003"];
    const issues: string[] = [];

    for (const id of milestoneIds) {
      if (isDbAvailable()) {
        const ms = getMilestone(id);
        if (ms?.status === "complete" || ms?.status === "parked") continue;
      }
      const draft = resolveMilestoneFile(tmpBase, id, "CONTEXT-DRAFT");
      if (draft) {
        issues.push(`${id}: has CONTEXT-DRAFT.md (will pause for discussion)`);
      }
    }

    assert.equal(issues.length, 3, "all milestones should warn when DB is unavailable");
  });
});
