import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writePhaseAnchor, readPhaseAnchor, formatAnchorForPrompt } from "../phase-anchor.js";
import type { PhaseAnchor } from "../phase-anchor.js";

function makeTempBase(): string {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-anchor-test-"));
  mkdirSync(join(tmp, ".gsd", "milestones", "M001", "anchors"), { recursive: true });
  return tmp;
}

test("writePhaseAnchor creates anchor file in correct location", () => {
  const base = makeTempBase();
  try {
    const anchor: PhaseAnchor = {
      phase: "discuss",
      milestoneId: "M001",
      generatedAt: new Date().toISOString(),
      intent: "Define authentication requirements",
      decisions: ["Use JWT tokens", "Session expiry 24h"],
      blockers: [],
      nextSteps: ["Plan the implementation slices"],
    };
    writePhaseAnchor(base, "M001", anchor);
    assert.ok(existsSync(join(base, ".gsd", "milestones", "M001", "anchors", "discuss.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPhaseAnchor returns written anchor", () => {
  const base = makeTempBase();
  try {
    const anchor: PhaseAnchor = {
      phase: "plan",
      milestoneId: "M001",
      generatedAt: new Date().toISOString(),
      intent: "Break work into slices",
      decisions: ["3 slices: auth, UI, tests"],
      blockers: ["Need DB schema first"],
      nextSteps: ["Execute S01"],
    };
    writePhaseAnchor(base, "M001", anchor);
    const read = readPhaseAnchor(base, "M001", "plan");
    assert.ok(read);
    assert.equal(read!.intent, "Break work into slices");
    assert.deepEqual(read!.decisions, ["3 slices: auth, UI, tests"]);
    assert.deepEqual(read!.blockers, ["Need DB schema first"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPhaseAnchor returns null when no anchor exists", () => {
  const base = makeTempBase();
  try {
    const read = readPhaseAnchor(base, "M001", "discuss");
    assert.equal(read, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("formatAnchorForPrompt produces markdown block", () => {
  const anchor: PhaseAnchor = {
    phase: "discuss",
    milestoneId: "M001",
    generatedAt: "2026-04-03T00:00:00.000Z",
    intent: "Define requirements",
    decisions: ["Use JWT"],
    blockers: [],
    nextSteps: ["Plan slices"],
  };
  const md = formatAnchorForPrompt(anchor);
  assert.ok(md.includes("## Handoff from discuss"));
  assert.ok(md.includes("Define requirements"));
  assert.ok(md.includes("Use JWT"));
  assert.ok(md.includes("Plan slices"));
});
