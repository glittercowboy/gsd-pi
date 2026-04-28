// GSD-2 — Deep planning mode end-to-end dispatch chain integration test.
//
// Unit-level tests (deep-planning-mode-dispatch.test.ts) invoke each
// rule's match() in isolation and miss ordering bugs. This test exercises
// resolveDispatch with all rules loaded and verifies that, in deep mode,
// the project-level stage gates fire in the correct order — even when
// state.phase is "needs-discussion" (which previously short-circuited
// to discuss-milestone before any deep rule could run).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveDispatch, type DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import type { GSDPreferences } from "../preferences.ts";

function makeIsolatedBase(): string {
  const base = join(tmpdir(), `gsd-deep-integration-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function makeCtx(
  basePath: string,
  prefs: GSDPreferences | undefined,
  phase: GSDState["phase"] = "needs-discussion",
): DispatchContext {
  const state: GSDState = {
    phase,
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }],
  };
  return {
    basePath,
    mid: "M001",
    midTitle: "Test",
    state,
    prefs,
    structuredQuestionsAvailable: "false",
  };
}

// PREFERENCES.md frontmatter that satisfies the workflow-preferences stage
// gate. The dispatch layer keys off the explicit `workflow_prefs_captured`
// marker, not on individual key presence — see isWorkflowPrefsCaptured.
const capturedPreferencesMd = `---
planning_depth: deep
workflow_prefs_captured: true
commit_policy: per-task
branch_model: single
uat_dispatch: true
models:
  executor_class: balanced
phases:
  skip_research: false
---
`;

function writePreferences(base: string): void {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), capturedPreferencesMd);
}

// ─── Regression test for B1: rule ordering bug ────────────────────────────

test("integration: deep mode + needs-discussion + nothing captured → workflow-preferences (NOT discuss-milestone)", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch", `expected dispatch, got ${result.action}: ${JSON.stringify(result)}`);
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "workflow-preferences",
      "deep mode in needs-discussion with no captured prefs must dispatch workflow-preferences first, not discuss-milestone",
    );
  }
});

test("integration: deep mode + pre-planning + nothing captured → workflow-preferences", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "pre-planning"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "workflow-preferences");
  }
});

test("integration: deep mode + prefs captured + no PROJECT.md → discuss-project", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writePreferences(base);

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
});

test("integration: deep mode + PROJECT.md + no REQUIREMENTS.md → discuss-requirements", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writePreferences(base);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
  }
});

test("integration: deep mode + REQUIREMENTS.md + no research-decision → research-decision", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writePreferences(base);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-decision");
  }
});

test("integration: deep mode + decision=research + research files missing → research-project", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writePreferences(base);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research" }),
  );

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
  }
});

test("integration: deep mode + decision=skip → falls through to discuss-milestone in needs-discussion", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writePreferences(base);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "skip" }),
  );

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "after all deep stage gates pass and user skipped research, milestone discussion should fire",
    );
  }
});

test("integration: deep mode + decision=<garbage> → research-decision (NOT discuss-milestone)", async (t) => {
  // Regression test for peer-review finding: hasPendingDeepStage previously
  // only treated decision === "research" as needing follow-up files;
  // anything else (including unrecognized values) silently passed the gate
  // and the milestone rule fired before research-decision could re-ask.
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writePreferences(base);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "garbage" }),
  );

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "research-decision",
      "unrecognized decision value must re-ask via research-decision, not advance to milestone work",
    );
  }
});

// ─── Light-mode regression check ──────────────────────────────────────────

test("integration: light mode (no prefs) + needs-discussion → discuss-milestone (unchanged behavior)", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const result = await resolveDispatch(makeCtx(base, undefined, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
});

test("integration: light mode + planning_depth=light + needs-discussion → discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "light" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
});
