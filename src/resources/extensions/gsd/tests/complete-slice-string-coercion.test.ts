// GSD Extension — String coercion regression tests for complete-slice/task tools

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
} from "../gsd-db.ts";
import { handleCompleteSlice } from "../tools/complete-slice.ts";
import type { CompleteSliceParams } from "../types.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * The splitPair coercion logic extracted from db-tools.ts sliceCompleteExecute.
 * Duplicated here so we can unit-test it directly.
 */
function splitPair(s: string): [string, string] {
  const m = s.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
  return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ""];
}

function makeValidSliceParams(): CompleteSliceParams {
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
    keyDecisions: ["D001"],
    patternsEstablished: [],
    observabilitySurfaces: [],
    provides: ["test handler"],
    requirementsSurfaced: [],
    drillDownPaths: [],
    affects: [],
    requirementsAdvanced: [{ id: "R001", how: "Handler validates" }],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [{ path: "src/foo.ts", description: "Handler" }],
    requires: [],
    uatContent: "## Smoke Test\n\nVerify all assertions pass.",
  };
}

// ─── splitPair unit tests ────────────────────────────────────────────────

describe("splitPair coercion helper (#3565)", () => {
  test("plain string without delimiter returns string + empty", () => {
    const [a, b] = splitPair("src/foo.ts");
    assert.equal(a, "src/foo.ts");
    assert.equal(b, "");
  });

  test("em-dash delimiter parses both parts", () => {
    const [id, how] = splitPair("R001 — Handler validates task completion");
    assert.equal(id, "R001");
    assert.equal(how, "Handler validates task completion");
  });

  test("hyphen delimiter parses both parts", () => {
    const [id, proof] = splitPair("R002 - Tests pass");
    assert.equal(id, "R002");
    assert.equal(proof, "Tests pass");
  });

  test("string with no space around hyphen is treated as plain", () => {
    // e.g. a file path like "src/foo-bar.ts" should not split
    const [a, b] = splitPair("src/foo-bar.ts");
    assert.equal(a, "src/foo-bar.ts");
    assert.equal(b, "");
  });

  test("whitespace is trimmed from both parts", () => {
    const [id, how] = splitPair("  R003  —  Trimmed value  ");
    assert.equal(id, "R003");
    assert.equal(how, "Trimmed value");
  });
});

// ─── verificationEvidence sentinel tests ─────────────────────────────────

describe("verificationEvidence sentinel coercion (#3565)", () => {
  function coerceEvidence(v: any) {
    return typeof v === "string"
      ? { command: v, exitCode: -1, verdict: "unknown (coerced from string)", durationMs: 0 }
      : v;
  }

  test("string input produces non-passing sentinel", () => {
    const result = coerceEvidence("npm test");
    assert.equal(result.command, "npm test");
    assert.equal(result.exitCode, -1);
    assert.equal(result.verdict, "unknown (coerced from string)");
    assert.equal(result.durationMs, 0);
  });

  test("object input passes through unchanged", () => {
    const obj = { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 };
    const result = coerceEvidence(obj);
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, "pass");
    assert.equal(result.durationMs, 1234);
  });

  test("sentinel exitCode is not 0 (must not fabricate success)", () => {
    const result = coerceEvidence("anything");
    assert.notEqual(result.exitCode, 0, "exitCode must not be 0 for coerced strings");
    assert.ok(
      !result.verdict.includes("pass"),
      "verdict must not contain 'pass' for coerced strings",
    );
  });
});

// ─── Handler integration with coerced params ─────────────────────────────

describe("handleCompleteSlice with coerced string arrays (#3565)", () => {
  let dbPath: string;
  let basePath: string;

  beforeEach(() => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "gsd-coerce-")),
      "test.db",
    );
    openDatabase(dbPath);

    basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-coerce-handler-"));
    const sliceDir = path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    fs.mkdirSync(sliceDir, { recursive: true });

    const roadmapPath = path.join(basePath, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    fs.writeFileSync(
      roadmapPath,
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
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "Task 1" });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  test("handler succeeds with coerced filesModified and requirementsAdvanced", async () => {
    const params = makeValidSliceParams();
    // Simulate coercion from plain strings
    params.filesModified = ["src/foo.ts", "src/bar.ts"].map((f) => {
      const [p, d] = splitPair(f);
      return { path: p, description: d };
    });
    params.requirementsAdvanced = ["R001 — Handler validates task completion"].map((r) => {
      const [id, how] = splitPair(r);
      return { id, how };
    });

    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), "handler should succeed");
    if (!("error" in result)) {
      const summary = fs.readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /src\/foo\.ts/);
      assert.match(summary, /R001/);
      assert.match(summary, /Handler validates task completion/);
    }
  });

  test("handler succeeds with coerced requires and requirementsValidated", async () => {
    const params = makeValidSliceParams();
    params.requires = ["S00 — Provided base infrastructure"].map((r) => {
      const [slice, provides] = splitPair(r);
      return { slice, provides };
    });
    params.requirementsValidated = ["R002 - Tests pass"].map((r) => {
      const [id, proof] = splitPair(r);
      return { id, proof };
    });

    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), "handler should succeed");
    if (!("error" in result)) {
      const summary = fs.readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /S00/);
      assert.match(summary, /Provided base infrastructure/);
      assert.match(summary, /R002/);
      assert.match(summary, /Tests pass/);
    }
  });
});
