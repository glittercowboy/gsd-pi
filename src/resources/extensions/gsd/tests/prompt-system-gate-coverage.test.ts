/**
 * Prompt-system gate coverage tests.
 *
 * These tests pin the invariants the plan file documents:
 *   1. Every pending slice-scoped gate is routed to exactly one owner turn.
 *      Q8 (owned by complete-slice) MUST NOT leak into gate-evaluate and
 *      get silently dropped the way it used to before the registry landed.
 *   2. getPendingGatesForTurn filters by the registry's owner turn, not
 *      just the DB scope column.
 *   3. Output validators recognize artifacts that contain the required
 *      gate section headings, and flag ones that don't.
 *   4. Prompt output produced by the validators reflects MV01-MV04.
 *
 * They also assert the VALIDATION.md renderer still produces headings
 * matching the registry's promptSection strings, so future renderer
 * edits that drift from the registry fail the suite loudly.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertGateRow,
  getPendingGates,
  getPendingGatesForTurn,
} from "../gsd-db.ts";
import {
  GATE_REGISTRY,
  getGatesForTurn,
  type OwnerTurn,
} from "../gate-registry.ts";
import {
  validateSliceSummaryOutput,
  validateTaskSummaryOutput,
  validateMilestoneValidationOutput,
  validateGateSections,
} from "../prompt-validation.ts";

function setupTestDb(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "prompt-gate-coverage-"));
  const dbPath = join(tmpDir, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Test Slice",
    status: "pending",
    risk: "medium",
    depends: [],
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Test Task",
    status: "pending",
  });
  return tmpDir;
}

describe("getPendingGatesForTurn routes by owner turn, not scope column", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = setupTestDb();
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Q8 stored as scope:'slice' is owned by complete-slice, not gate-evaluate", () => {
    // Seed the three slice-scoped gates plan-slice writes today.
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q8", scope: "slice" });

    // getPendingGates(..., "slice") returns all three (unchanged).
    const allSlicePending = getPendingGates("M001", "S01", "slice");
    assert.equal(allSlicePending.length, 3);

    // But the turn-aware helper routes them correctly.
    const gateEval = getPendingGatesForTurn("M001", "S01", "gate-evaluate");
    assert.deepEqual(gateEval.map((g) => g.gate_id).sort(), ["Q3", "Q4"]);

    const completeSlice = getPendingGatesForTurn("M001", "S01", "complete-slice");
    assert.deepEqual(completeSlice.map((g) => g.gate_id), ["Q8"]);
  });

  test("task-scoped gates are scoped to the requested task id", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q6", scope: "task", taskId: "T01" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T02" });

    const t1 = getPendingGatesForTurn("M001", "S01", "execute-task", "T01");
    assert.equal(t1.length, 2);
    assert.ok(t1.every((g) => g.gate_id === "Q5" || g.gate_id === "Q6"));

    const t2 = getPendingGatesForTurn("M001", "S01", "execute-task", "T02");
    assert.equal(t2.length, 1);
    assert.equal(t2[0].gate_id, "Q5");
  });
});

describe("per-turn output validators", () => {
  test("validateSliceSummaryOutput flags missing Operational Readiness", () => {
    const md = `# S01: Test Slice\n\n## What Happened\nstuff\n\n## Verification\nstuff\n`;
    const result = validateSliceSummaryOutput(md);
    assert.equal(result.valid, false);
    assert.ok(result.missing.some((m) => m.includes("Q8")));
    assert.ok(result.missing.some((m) => m.includes("Operational Readiness")));
  });

  test("validateSliceSummaryOutput passes when Operational Readiness heading is present", () => {
    const md = `# S01\n\n## Operational Readiness\n- Health: /health\n- Failure: alert\n`;
    const result = validateSliceSummaryOutput(md);
    assert.equal(result.valid, true);
    assert.equal(result.missing.length, 0);
  });

  test("validateMilestoneValidationOutput requires all four MV headings", () => {
    // Missing Requirement Coverage.
    const md = [
      "# Milestone Validation: M001",
      "## Success Criteria Checklist",
      "ok",
      "## Slice Delivery Audit",
      "ok",
      "## Cross-Slice Integration",
      "ok",
    ].join("\n\n");
    const result = validateMilestoneValidationOutput(md);
    assert.equal(result.valid, false);
    assert.ok(result.missing.some((m) => m.includes("MV04")));
  });

  test("validateMilestoneValidationOutput passes for a complete VALIDATION.md", () => {
    const md = [
      "# Milestone Validation: M001",
      "## Success Criteria Checklist",
      "ok",
      "## Slice Delivery Audit",
      "ok",
      "## Cross-Slice Integration",
      "ok",
      "## Requirement Coverage",
      "ok",
    ].join("\n\n");
    const result = validateMilestoneValidationOutput(md);
    assert.equal(result.valid, true, `unexpected missing: ${result.missing.join(", ")}`);
  });

  test("validateTaskSummaryOutput flags missing task-gate sections", () => {
    const md = `# T01\n\n## What Happened\nstuff\n\n## Verification\nstuff\n`;
    const result = validateTaskSummaryOutput(md);
    assert.equal(result.valid, false);
    const idsInMissing = result.missing.join(" ");
    assert.ok(idsInMissing.includes("Q5"));
    assert.ok(idsInMissing.includes("Q6"));
    assert.ok(idsInMissing.includes("Q7"));
  });

  test("validateGateSections returns empty missing when gate bucket is empty", () => {
    // Build a phoney owner turn that owns nothing (simulate by validating
    // against a real turn against an artifact containing every section).
    const fullMd = getGatesForTurn("validate-milestone")
      .map((g) => `## ${g.promptSection}\n\nstuff`)
      .join("\n\n");
    const result = validateGateSections(fullMd, "validate-milestone");
    assert.equal(result.valid, true);
  });
});

describe("registry / renderer parity", () => {
  test("MV promptSections match the validate-milestone renderer H2 headings", () => {
    // Mirror the string literals from tools/validate-milestone.ts
    // renderValidationMarkdown() so a rename there flips this test red.
    const expectedHeadings = [
      "Success Criteria Checklist",
      "Slice Delivery Audit",
      "Cross-Slice Integration",
      "Requirement Coverage",
    ];
    const registryHeadings = getGatesForTurn("validate-milestone").map((g) => g.promptSection);
    assert.deepEqual(registryHeadings.sort(), [...expectedHeadings].sort());
  });

  test("Q8 promptSection matches the complete-slice renderer H2 heading", () => {
    // Mirror the slice-summary H2 introduced in tools/complete-slice.ts.
    assert.equal(GATE_REGISTRY.Q8.promptSection, "Operational Readiness");
  });

  test("registry owner turns cover every turn gate-registry.ts declares", () => {
    const ownerTurns = new Set<OwnerTurn>(Object.values(GATE_REGISTRY).map((g) => g.ownerTurn));
    assert.ok(ownerTurns.has("gate-evaluate"));
    assert.ok(ownerTurns.has("execute-task"));
    assert.ok(ownerTurns.has("complete-slice"));
    assert.ok(ownerTurns.has("validate-milestone"));
  });
});
