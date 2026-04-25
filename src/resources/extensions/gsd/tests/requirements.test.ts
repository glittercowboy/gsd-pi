import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirementCounts } from "../files.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState } from "../state.ts";
import { runGSDDoctor } from "../doctor.ts";

describe('requirements', () => {
  test('requirement counts parser', () => {
    const counts = parseRequirementCounts(`# Requirements

## Active

### R001 — Foo
- Status: active

### R002 — Bar
- Status: blocked

## Validated

### R010 — Baz
- Status: validated

## Deferred

### R020 — Qux
- Status: deferred

## Out of Scope

### R030 — No
- Status: out-of-scope
`);
    assert.deepStrictEqual(counts.active, 2, "counts active requirements by section");
    assert.deepStrictEqual(counts.validated, 1, "counts validated requirements");
    assert.deepStrictEqual(counts.deferred, 1, "counts deferred requirements");
    assert.deepStrictEqual(counts.outOfScope, 1, "counts out of scope requirements");
    assert.deepStrictEqual(counts.blocked, 1, "counts blocked statuses");
  });

  const base = mkdtempSync(join(tmpdir(), "gsd-requirements-test-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(gsd, "REQUIREMENTS.md"), [
    "# Requirements",
    "## Active",
    "### R001 — Missing owner",
    "- Class: core-capability",
    "- Status: active",
    "- Description: thing",
    "- Why it matters: thing",
    "- Source: user",
    "- Primary owning slice: none yet",
    "- Supporting slices: none",
    "- Validation: unmapped",
    "- Notes: none",
    "## Validated",
    "## Deferred",
    "## Out of Scope",
    "## Traceability",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(mDir, "M001-ROADMAP.md"), [
    "# M001: Demo",
    "## Slices",
    "- [ ] **S01: Demo Slice** `risk:low` `depends:[]`",
    "  > After this: demo works",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(sDir, "S01-PLAN.md"), [
    "# S01: Demo Slice",
    "**Goal:** Demo",
    "**Demo:** Demo",
    "## Must-Haves",
    "- done",
    "## Tasks",
    "- [ ] **T01: Implement thing** `est:10m`",
    "  Task is in progress.",
    "",
  ].join("\n"), "utf-8");
  test('deriveState includes requirements counts', async () => {
    const state = await deriveState(base);
    assert.ok(state.requirements !== undefined, "state includes requirements summary");
    assert.deepStrictEqual(state.requirements?.active, 1, "state reports active requirement count");
  });

  test('doctor flags orphaned active requirement', async () => {
    const report = await runGSDDoctor(base);
    assert.ok(report.issues.some(issue => issue.code === "active_requirement_missing_owner"), "doctor flags missing owner");
  });

  // #4414: active_requirement_missing_owner is a planning-hygiene signal,
  // not a correctness blocker — severity must be warning, not error.
  test('#4414: active_requirement_missing_owner is a warning, not an error', async () => {
    const report = await runGSDDoctor(base);
    const issue = report.issues.find(i => i.code === "active_requirement_missing_owner");
    assert.ok(issue, "issue is present");
    assert.equal(issue!.severity, "warning", "severity downgraded so doctor report.ok is not flipped to false");
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });
});
