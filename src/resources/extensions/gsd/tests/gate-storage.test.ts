// Quality gate DB storage tests
// Verifies CRUD operations on the quality_gates table.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertGateRow,
  saveGateResult,
  getPendingGates,
  getGateResults,
  markAllGatesOmitted,
  getPendingSliceGateCount,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";

describe("quality_gates CRUD", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gate-test-"));
    dbPath = join(tmpDir, "gsd.db");
    openDatabase(dbPath);
    // Seed parent rows
    insertMilestone({
      id: "M001",
      title: "Test Milestone",
      status: "active",
    });
    insertSlice({
      milestoneId: "M001",
      id: "S01",
      title: "Test Slice",
      status: "pending",
      risk: "medium",
      depends: [],
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("insertGateRow creates a pending gate", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    const pending = getPendingGates("M001", "S01");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].gate_id, "Q3");
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].scope, "slice");
  });

  test("insertGateRow with INSERT OR IGNORE is idempotent", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    const all = getGateResults("M001", "S01");
    assert.equal(all.length, 1);
  });

  test("saveGateResult updates status and verdict", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    saveGateResult({
      milestoneId: "M001",
      sliceId: "S01",
      gateId: "Q3",
      verdict: "pass",
      rationale: "No auth surface",
      findings: "This slice has no user-facing endpoints.",
    });
    const results = getGateResults("M001", "S01");
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "complete");
    assert.equal(results[0].verdict, "pass");
    assert.equal(results[0].rationale, "No auth surface");
    assert.ok(results[0].evaluated_at);
  });

  test("getPendingGates filters by scope", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });

    const sliceGates = getPendingGates("M001", "S01", "slice");
    assert.equal(sliceGates.length, 1);
    assert.equal(sliceGates[0].gate_id, "Q3");

    const taskGates = getPendingGates("M001", "S01", "task");
    assert.equal(taskGates.length, 1);
    assert.equal(taskGates[0].gate_id, "Q5");
  });

  test("markAllGatesOmitted marks all pending gates as omitted", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });

    markAllGatesOmitted("M001", "S01");

    const pending = getPendingGates("M001", "S01");
    assert.equal(pending.length, 0);

    const all = getGateResults("M001", "S01");
    assert.equal(all.length, 3);
    for (const g of all) {
      assert.equal(g.status, "omitted");
      assert.equal(g.verdict, "omitted");
    }
  });

  test("getPendingSliceGateCount returns correct count", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });

    assert.equal(getPendingSliceGateCount("M001", "S01"), 2);

    saveGateResult({
      milestoneId: "M001", sliceId: "S01", gateId: "Q3",
      verdict: "pass", rationale: "OK", findings: "",
    });
    assert.equal(getPendingSliceGateCount("M001", "S01"), 1);
  });

  test("task-scoped gates with different task_id are distinct", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T02" });

    const all = getGateResults("M001", "S01", "task");
    assert.equal(all.length, 2);
  });

  test("getGateResults returns empty for nonexistent slice", () => {
    const results = getGateResults("M001", "S99");
    assert.equal(results.length, 0);
  });

  test("saveGateResult with flag verdict preserves findings", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    saveGateResult({
      milestoneId: "M001", sliceId: "S01", gateId: "Q4",
      verdict: "flag", rationale: "Breaks R003",
      findings: "## R003 Impact\n\n- Login flow must be re-tested\n- Session token format changed",
    });
    const results = getGateResults("M001", "S01", "slice");
    const q4 = results.find(g => g.gate_id === "Q4")!;
    assert.equal(q4.verdict, "flag");
    assert.ok(q4.findings.includes("R003 Impact"));
  });
});
