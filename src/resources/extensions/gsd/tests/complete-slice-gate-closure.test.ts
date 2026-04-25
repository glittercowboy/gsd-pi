/**
 * complete-slice gate closure integration test.
 *
 * Pins the fix for the Q8-stall bug: complete-slice must close every gate
 * owned by the complete-slice turn based on the content of the matching
 * CompleteSliceParams field. Without this, Q8 stays pending forever and
 * blocks state derivation on subsequent loops.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertGateRow,
  getGateResults,
} from "../gsd-db.ts";
import { handleCompleteSlice } from "../tools/complete-slice.ts";
import type { CompleteSliceParams } from "../types.ts";

function makeValidSliceParams(overrides: Partial<CompleteSliceParams> = {}): CompleteSliceParams {
  return {
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Test Slice",
    oneLiner: "Implemented test slice",
    narrative: "Built and tested.",
    verification: "All tests pass.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    keyFiles: ["src/foo.ts"],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    provides: [],
    requirementsSurfaced: [],
    drillDownPaths: [],
    affects: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [],
    requires: [],
    uatContent: "## Smoke Test\n\nVerify happy path.",
    ...overrides,
  };
}

describe("complete-slice closes complete-slice-owned gates", () => {
  let dbPath: string;
  let basePath: string;

  beforeEach(() => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "gsd-slice-gate-")),
      "test.db",
    );
    openDatabase(dbPath);

    basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-slice-gate-handler-"));
    const sliceDir = path.join(
      basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks",
    );
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(
      path.join(basePath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        '- [ ] **S01: Test Slice** `risk:medium` `depends:[]`',
        "  - After this: basic functionality works",
      ].join("\n"),
    );

    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({
      id: "T01", sliceId: "S01", milestoneId: "M001",
      status: "complete", title: "Task 1",
    });

    // Seed Q8 as pending — this is what plan-slice does today.
    insertGateRow({
      milestoneId: "M001", sliceId: "S01",
      gateId: "Q8", scope: "slice",
    });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  test("Q8 closes as 'pass' when operationalReadiness is populated", async () => {
    const params = makeValidSliceParams({
      operationalReadiness: [
        "- Health signal: /health endpoint returns 200",
        "- Failure signal: error rate alert in observability dashboard",
        "- Recovery: systemd auto-restart",
      ].join("\n"),
    });

    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), `handler failed: ${(result as any).error}`);

    const gates = getGateResults("M001", "S01", "slice");
    const q8 = gates.find((g) => g.gate_id === "Q8");
    assert.ok(q8, "Q8 row must exist after complete-slice");
    assert.equal(q8.status, "complete");
    assert.equal(q8.verdict, "pass");
    assert.ok(
      q8.findings.includes("Health signal"),
      "Q8 findings must capture the operationalReadiness content",
    );
  });

  test("Q8 closes as 'omitted' when operationalReadiness is empty", async () => {
    const params = makeValidSliceParams({ operationalReadiness: "" });

    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), `handler failed: ${(result as any).error}`);

    const gates = getGateResults("M001", "S01", "slice");
    const q8 = gates.find((g) => g.gate_id === "Q8");
    assert.ok(q8, "Q8 row must exist after complete-slice");
    assert.equal(q8.status, "complete");
    assert.equal(q8.verdict, "omitted");
  });

  test("Q8 also closes when operationalReadiness is omitted entirely", async () => {
    // A model that doesn't pass operationalReadiness at all must still
    // move Q8 out of 'pending' — leaving it pending produces the stall.
    const params = makeValidSliceParams();
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), `handler failed: ${(result as any).error}`);

    const gates = getGateResults("M001", "S01", "slice");
    const q8 = gates.find((g) => g.gate_id === "Q8");
    assert.ok(q8);
    assert.notEqual(q8.status, "pending", "Q8 must never remain pending after complete-slice");
    assert.equal(q8.verdict, "omitted");
  });

  test("summary markdown contains Operational Readiness section", async () => {
    const params = makeValidSliceParams({
      operationalReadiness: "- Health signal: /health\n- Failure signal: alert",
    });
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result));
    if (!("error" in result)) {
      const summary = fs.readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /^## Operational Readiness/m);
      assert.match(summary, /Health signal: \/health/);
    }
  });
});
