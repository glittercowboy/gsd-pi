import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { handleValidateMilestone } from "../tools/validate-milestone.js";
import { openDatabase, closeDatabase, _getAdapter, insertMilestone, insertSlice } from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-val-handler-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

const VALID_PARAMS = {
  milestoneId: "M001",
  verdict: "pass" as const,
  remediationRound: 0,
  successCriteriaChecklist: "- [x] All pass",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "No issues",
  requirementCoverage: "All covered",
  verificationClasses: "- Contract: covered\n- Integration: covered\n- Operational: gap noted",
  verdictRationale: "Everything checks out",
};

describe("handleValidateMilestone write ordering (#2725)", () => {
  let base: string;

  afterEach(() => {
    clearPathCache();
    clearParseCache();
    try { closeDatabase(); } catch { /* */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("writes DB row and disk file on success", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    // DB row exists
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status, scope FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string; scope: string } | undefined;
    assert.ok(row, "assessment row should exist in DB");
    assert.equal(row!.status, "pass");

    // Disk file exists
    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.ok(existsSync(filePath), "VALIDATION.md should exist on disk");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.match(validationMd, /## Verification Class Compliance/);
    assert.match(validationMd, /- Contract: covered/);
    assert.match(validationMd, /## Verdict Rationale/);
  });

  it("omits verification class section when no verification classes are supplied", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(
      { ...VALID_PARAMS, verificationClasses: undefined },
      base,
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.doesNotMatch(validationMd, /## Verification Class Compliance/);
  });

  it("rolls back DB row when disk write fails", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    // Force disk write failure by replacing the milestone directory with a
    // regular file. saveFile() will fail because it cannot write inside a
    // non-directory. This works cross-platform (chmod is ignored on Windows).
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    rmSync(milestoneDir, { recursive: true, force: true });
    writeFileSync(milestoneDir, "not-a-directory");

    const result = await handleValidateMilestone(VALID_PARAMS, base);

    // Should return error
    assert.ok("error" in result, "should return error when disk write fails");
    assert.ok(result.error.includes("disk render failed"));

    // DB row should have been rolled back (deleted)
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get();
    assert.equal(row, undefined, "assessment row should be deleted after disk-write rollback");
  });

  it("persists milestone validation gate_runs rows when UOK gates are enabled", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(VALID_PARAMS, base, {
      uokGatesEnabled: true,
      traceId: "trace-val-1",
      turnId: "turn-val-1",
    });
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT gate_id, outcome, failure_class, trace_id, turn_id
       FROM gate_runs
       WHERE gate_id = 'milestone-validation-gates'
       ORDER BY id DESC
       LIMIT 1`,
    ).get() as
      | {
          gate_id: string;
          outcome: string;
          failure_class: string;
          trace_id: string;
          turn_id: string;
        }
      | undefined;

    assert.ok(row, "milestone validation gate row should be persisted");
    assert.equal(row?.gate_id, "milestone-validation-gates");
    assert.equal(row?.outcome, "pass");
    assert.equal(row?.failure_class, "none");
    assert.equal(row?.trace_id, "trace-val-1");
    assert.equal(row?.turn_id, "turn-val-1");
  });
});
