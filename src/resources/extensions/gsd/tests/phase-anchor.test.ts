import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writePhaseAnchor, readPhaseAnchor, formatAnchorForPrompt, extractHandoffData } from "../phase-anchor.js";
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

test("writePhaseAnchor uses sliceId in filename for slice phases", () => {
  const base = makeTempBase();
  try {
    const anchor: PhaseAnchor = {
      phase: "research-slice",
      milestoneId: "M001",
      sliceId: "S01",
      generatedAt: new Date().toISOString(),
      intent: "Research S01",
      decisions: [],
      blockers: [],
      nextSteps: [],
    };
    writePhaseAnchor(base, "M001", anchor);
    assert.ok(existsSync(join(base, ".gsd", "milestones", "M001", "anchors", "research-slice_S01.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("slice anchors from different slices do not collide", () => {
  const base = makeTempBase();
  try {
    writePhaseAnchor(base, "M001", {
      phase: "research-slice",
      milestoneId: "M001",
      sliceId: "S01",
      generatedAt: new Date().toISOString(),
      intent: "Research for S01",
      decisions: ["Decision A"],
      blockers: [],
      nextSteps: [],
    });
    writePhaseAnchor(base, "M001", {
      phase: "research-slice",
      milestoneId: "M001",
      sliceId: "S02",
      generatedAt: new Date().toISOString(),
      intent: "Research for S02",
      decisions: ["Decision B"],
      blockers: [],
      nextSteps: [],
    });
    const s01 = readPhaseAnchor(base, "M001", "research-slice", "S01");
    const s02 = readPhaseAnchor(base, "M001", "research-slice", "S02");
    assert.ok(s01);
    assert.ok(s02);
    assert.equal(s01!.intent, "Research for S01");
    assert.equal(s02!.intent, "Research for S02");
    assert.deepEqual(s01!.decisions, ["Decision A"]);
    assert.deepEqual(s02!.decisions, ["Decision B"]);
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

test("extractHandoffData parses decisions and next steps from artifact", () => {
  const base = makeTempBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-RESEARCH.md"), [
      "# Authentication research for S01",
      "",
      "## Decisions",
      "- Use OAuth2 with PKCE",
      "- Store tokens in httpOnly cookies",
      "",
      "## Blockers",
      "- Need API key from provider",
      "",
      "## Next Steps",
      "- Implement token refresh flow",
      "- Add logout endpoint",
    ].join("\n"), "utf-8");

    const data = extractHandoffData(base, "M001", "research-slice", "M001/S01", "S01");
    assert.equal(data.intent, "Authentication research for S01");
    assert.deepEqual(data.decisions, ["Use OAuth2 with PKCE", "Store tokens in httpOnly cookies"]);
    assert.deepEqual(data.blockers, ["Need API key from provider"]);
    assert.deepEqual(data.nextSteps, ["Implement token refresh flow", "Add logout endpoint"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("extractHandoffData returns defaults when no artifact exists", () => {
  const base = makeTempBase();
  try {
    const data = extractHandoffData(base, "M001", "research-slice", "M001/S01", "S01");
    assert.equal(data.intent, "Completed research-slice for M001/S01");
    assert.deepEqual(data.decisions, []);
    assert.deepEqual(data.blockers, []);
    assert.deepEqual(data.nextSteps, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
