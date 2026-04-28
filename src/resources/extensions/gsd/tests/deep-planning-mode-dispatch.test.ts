// GSD-2 — Deep planning mode dispatch behavior contract.
// Verifies the new deep-mode dispatch rules guard correctly on prefs.planning_depth
// and on artifact presence, and that light mode behavior is unaffected.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DISPATCH_RULES,
  setResearchProjectPromptBuilderForTest,
  type DispatchContext,
} from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import type { GSDPreferences } from "../preferences.ts";

const WORKFLOW_PREFS_RULE_NAME = "deep: pre-planning (no workflow prefs) → workflow-preferences";
const PROJECT_RULE_NAME = "deep: pre-planning (no PROJECT) → discuss-project";
const REQUIREMENTS_RULE_NAME = "deep: pre-planning (no REQUIREMENTS) → discuss-requirements";
const RESEARCH_DECISION_RULE_NAME = "deep: pre-planning (no research decision) → research-decision";
const RESEARCH_PROJECT_RULE_NAME = "deep: pre-planning (research approved, files missing) → research-project";

const VALID_PROJECT_MD = [
  "# Project",
  "",
  "## What This Is",
  "",
  "A test project.",
  "",
  "## Core Value",
  "",
  "Reliable dispatch behavior.",
  "",
  "## Current State",
  "",
  "Tests are exercising deep planning.",
  "",
  "## Architecture / Key Patterns",
  "",
  "Markdown artifacts drive stage gates.",
  "",
  "## Capability Contract",
  "",
  "See `.gsd/REQUIREMENTS.md`.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Test - exercise deep planning dispatch",
  "",
].join("\n");

const VALID_REQUIREMENTS_MD = [
  "# Requirements",
  "",
  "## Active",
  "",
  "### R001 - Dispatch valid artifacts",
  "- Class: core-capability",
  "- Status: active",
  "- Description: Valid artifacts allow deep-mode dispatch to advance.",
  "- Why it matters: Stage gates must not stall valid projects.",
  "- Source: test",
  "- Primary owning slice: M001/S01",
  "- Supporting slices: none",
  "- Validation: unmapped",
  "- Notes:",
  "",
  "## Validated",
  "",
  "## Deferred",
  "",
  "## Out of Scope",
  "",
  "## Traceability",
  "",
  "| ID | Class | Status | Primary owner | Supporting | Proof |",
  "|---|---|---|---|---|---|",
  "| R001 | core-capability | active | M001/S01 | none | unmapped |",
  "",
  "## Coverage Summary",
  "",
  "- Active requirements: 1",
  "",
].join("\n");

function makeIsolatedBase(): string {
  const base = join(tmpdir(), `gsd-deep-planning-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function writeValidProject(base: string): void {
  writeFileSync(join(base, ".gsd", "PROJECT.md"), VALID_PROJECT_MD);
}

function writeValidRequirements(base: string): void {
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), VALID_REQUIREMENTS_MD);
}

function makeCtx(
  basePath: string,
  prefs: GSDPreferences | undefined,
  phase: GSDState["phase"] = "pre-planning",
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

function rule(name: string) {
  const r = DISPATCH_RULES.find(x => x.name === name);
  assert.ok(r, `dispatch rule "${name}" must exist`);
  return r!;
}

// ─── workflow-preferences rule ────────────────────────────────────────────

test("Deep mode: workflow-preferences does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, undefined));
  assert.strictEqual(result, null);
});

test("Deep mode: workflow-preferences DOES dispatch in deep mode when PREFERENCES.md missing", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "workflow-preferences");
    assert.strictEqual(result.unitId, "WORKFLOW-PREFS");
  }
});

test("Deep mode: workflow-preferences DOES dispatch when PREFERENCES.md exists but lacks workflow_prefs_captured marker", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  // Partial PREFERENCES.md (e.g. only planning_depth set) must not falsely
  // suppress the wizard — the explicit captured marker is required.
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "missing capture marker must re-fire wizard");
});

test("Deep mode: workflow-preferences DOES dispatch when frontmatter is malformed", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nthis is not valid yaml: [\n---\n");
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "malformed frontmatter treated as not captured");
});

test("Deep mode: workflow-preferences does NOT dispatch when PREFERENCES.md has workflow_prefs_captured: true", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\ncommit_policy: per-task\n---\n",
  );
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
});

// ─── discuss-project rule ─────────────────────────────────────────────────

test("Deep mode: discuss-project does NOT dispatch when planning_depth is undefined (default light)", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, undefined));
  assert.strictEqual(result, null, "light mode (default) must not fire deep-mode rule");
});

test("Deep mode: discuss-project does NOT dispatch when planning_depth is 'light'", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "light" } as GSDPreferences;
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "explicit light mode must not fire deep-mode rule");
});

test("Deep mode: discuss-project DOES dispatch when planning_depth is 'deep' and PROJECT.md missing", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "deep mode + missing PROJECT.md must dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
    assert.strictEqual(result.unitId, "PROJECT");
    assert.ok(result.prompt.length > 0, "prompt must be non-empty");
  }
});

test("Deep mode: discuss-project does NOT dispatch when PROJECT.md already exists and is valid", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "valid PROJECT.md must fall through to next rule");
});

test("Deep mode: discuss-project DOES dispatch when PROJECT.md exists but is invalid", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "invalid PROJECT.md must re-fire discuss-project");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
    assert.strictEqual(result.unitId, "PROJECT");
  }
});

test("Deep mode: discuss-project does NOT dispatch in non-pre-planning phases", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs, "executing"));
  assert.strictEqual(result, null, "execution phases must not fire project-level discussion");
});

test("Deep mode: discuss-project DOES dispatch in needs-discussion phase", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs, "needs-discussion"));
  assert.ok(result && result.action === "dispatch", "needs-discussion is a valid entry phase");
});

// ─── discuss-requirements rule ────────────────────────────────────────────

test("Deep mode: discuss-requirements does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, undefined));
  assert.strictEqual(result, null, "light mode must not fire deep-mode requirements rule");
});

test("Deep mode: discuss-requirements does NOT dispatch when PROJECT.md missing (project rule must run first)", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "PROJECT.md missing — earlier rule handles");
});

test("Deep mode: discuss-requirements DOES dispatch when PROJECT.md exists and REQUIREMENTS.md missing", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "deep mode + PROJECT.md present + REQUIREMENTS.md missing must dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
    assert.strictEqual(result.unitId, "REQUIREMENTS");
  }
});

test("Deep mode: discuss-requirements does NOT dispatch when REQUIREMENTS.md already exists and is valid", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeValidRequirements(base);
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "valid REQUIREMENTS.md must fall through");
});

test("Deep mode: discuss-requirements DOES dispatch when REQUIREMENTS.md exists but is invalid", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "invalid REQUIREMENTS.md must re-fire discuss-requirements");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
    assert.strictEqual(result.unitId, "REQUIREMENTS");
  }
});

// ─── research-decision rule ───────────────────────────────────────────────

test("Deep mode: research-decision does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeValidRequirements(base);
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, undefined));
  assert.strictEqual(result, null);
});

test("Deep mode: research-decision does NOT dispatch when REQUIREMENTS.md missing", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  // No REQUIREMENTS.md
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "REQUIREMENTS.md must exist before research decision is asked");
});

test("Deep mode: research-decision DOES dispatch when REQUIREMENTS.md exists and no decision marker", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeValidRequirements(base);
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-decision");
    assert.strictEqual(result.unitId, "RESEARCH-DECISION");
  }
});

test("Deep mode: research-decision does NOT dispatch when decision marker exists", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "decision already recorded — fall through");
});

// ─── research-project rule ────────────────────────────────────────────────

function setupReadyForResearchProject(base: string): void {
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", decided_at: "2026-04-27T00:00:00Z" }),
  );
}

test("Deep mode: research-project does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  setupReadyForResearchProject(base);
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, undefined));
  assert.strictEqual(result, null);
});

test("Deep mode: research-project does NOT dispatch when decision marker missing", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeValidRequirements(base);
  // No decision marker
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
});

test("Deep mode: research-project does NOT dispatch when user chose 'skip'", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "skip decision must short-circuit research-project");
});

test("Deep mode: research-project DOES dispatch when decision is 'research' and research files missing", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  setupReadyForResearchProject(base);
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
    assert.strictEqual(result.unitId, "RESEARCH-PROJECT");
  }
  assert.ok(
    existsSync(join(base, ".gsd", "runtime", "research-project-inflight")),
    "dispatch must create the in-flight marker before returning",
  );
});

test("Deep mode: research-project clears in-flight marker when prompt assembly fails", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const restorePromptBuilder = setResearchProjectPromptBuilderForTest(async () => {
    throw new Error("prompt assembly failed");
  });
  t.after(restorePromptBuilder);

  setupReadyForResearchProject(base);
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const markerPath = join(base, ".gsd", "runtime", "research-project-inflight");

  await assert.rejects(
    () => rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs)),
    /prompt assembly failed/,
  );
  assert.strictEqual(existsSync(markerPath), false, "failed prompt assembly must not strand the in-flight marker");
});

test("Deep mode: research-project does NOT dispatch while in-flight marker exists", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  setupReadyForResearchProject(base);
  writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "in-flight marker must suppress duplicate research-project dispatch");
});

test("Deep mode: research-project does NOT dispatch when all 4 research files exist", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "all research files present — fall through");
});

test("Deep mode: research-project treats a dimension BLOCKER as terminal", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  writeFileSync(join(base, ".gsd", "research", "PITFALLS-BLOCKER.md"), "# blocker\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "dimension blocker files must satisfy project research");
});

test("Deep mode: research-project DOES dispatch when only 3 of 4 research files exist", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  // PITFALLS.md missing
  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "any missing dimension must trigger re-run");
});

// ─── ordering invariant ───────────────────────────────────────────────────

test("Deep mode: deep-mode rules registered in correct order", () => {
  const workflowIdx = DISPATCH_RULES.findIndex(r => r.name === WORKFLOW_PREFS_RULE_NAME);
  const projectIdx = DISPATCH_RULES.findIndex(r => r.name === PROJECT_RULE_NAME);
  const requirementsIdx = DISPATCH_RULES.findIndex(r => r.name === REQUIREMENTS_RULE_NAME);
  const researchDecisionIdx = DISPATCH_RULES.findIndex(r => r.name === RESEARCH_DECISION_RULE_NAME);
  const researchProjectIdx = DISPATCH_RULES.findIndex(r => r.name === RESEARCH_PROJECT_RULE_NAME);
  const milestoneIdx = DISPATCH_RULES.findIndex(r => r.name === "pre-planning (no context) → discuss-milestone");

  assert.ok(workflowIdx >= 0, "workflow-preferences rule must be registered");
  assert.ok(projectIdx >= 0, "project rule must be registered");
  assert.ok(requirementsIdx >= 0, "requirements rule must be registered");
  assert.ok(researchDecisionIdx >= 0, "research-decision rule must be registered");
  assert.ok(researchProjectIdx >= 0, "research-project rule must be registered");
  assert.ok(milestoneIdx >= 0, "milestone rule must be registered");

  // Order: workflow-prefs → discuss-project → discuss-requirements → research-decision → research-project → discuss-milestone
  assert.ok(workflowIdx < projectIdx, "workflow-prefs must fire before discuss-project");
  assert.ok(projectIdx < requirementsIdx, "discuss-project must fire before discuss-requirements");
  assert.ok(requirementsIdx < researchDecisionIdx, "discuss-requirements must fire before research-decision");
  assert.ok(researchDecisionIdx < researchProjectIdx, "research-decision must fire before research-project (gate before action)");
  assert.ok(researchProjectIdx < milestoneIdx, "research-project must fire before discuss-milestone");
});
