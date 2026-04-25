// GSD — Onboarding state record tests.
// Verifies the explicit completion record (onboarding-state.ts) and step-evolution
// behavior in setup-catalog.ts, including stale-resume fallback and version semantics.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must isolate per-process to avoid clobbering the user's real ~/.gsd/agent/onboarding.json.
// We point GSD_HOME at a fresh tmp dir before importing the modules under test.
const tmpHome = mkdtempSync(join(tmpdir(), "gsd-onboarding-state-test-"));
process.env.GSD_HOME = tmpHome;

const state = await import("../onboarding-state.ts");
const catalog = await import("../setup-catalog.ts");

test.after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("default record returns when no file exists", () => {
  const r = state.readOnboardingRecord();
  assert.equal(r.completedAt, null);
  assert.deepEqual(r.completedSteps, []);
  assert.equal(r.flowVersion, state.FLOW_VERSION);
});

test("isOnboardingComplete is false until markOnboardingComplete is called", () => {
  state.resetOnboarding();
  assert.equal(state.isOnboardingComplete(), false);
  state.markOnboardingComplete(["llm"]);
  assert.equal(state.isOnboardingComplete(), true);
});

test("markStepCompleted updates lastResumePoint and dedupes", () => {
  state.resetOnboarding();
  state.markStepCompleted("llm");
  state.markStepCompleted("search");
  state.markStepCompleted("llm"); // dup
  const r = state.readOnboardingRecord();
  assert.deepEqual(r.completedSteps.filter(s => s === "llm"), ["llm"]);
  assert.equal(r.lastResumePoint, "llm"); // last write wins, even on dup
});

test("markStepSkipped excludes already-completed steps", () => {
  state.resetOnboarding();
  state.markStepCompleted("llm");
  state.markStepSkipped("llm");
  const r = state.readOnboardingRecord();
  assert.equal(r.skippedSteps.includes("llm"), false);
});

test("resetOnboarding clears completion but preserves flowVersion", () => {
  state.markOnboardingComplete(["llm", "search"]);
  state.resetOnboarding();
  const r = state.readOnboardingRecord();
  assert.equal(r.completedAt, null);
  assert.deepEqual(r.completedSteps, []);
  assert.equal(r.flowVersion, state.FLOW_VERSION);
});

test("flowVersion mismatch invalidates completion (forces re-onboarding)", () => {
  state.markOnboardingComplete(["llm"]);
  // Simulate a flow version bump after the user completed an older flow.
  state.writeOnboardingRecord({ flowVersion: state.FLOW_VERSION - 1 });
  assert.equal(state.isOnboardingComplete(), false);
});

test("nearestResumeStep returns first incomplete when resume point is stale", () => {
  // Stale ID — not in catalog
  const next = catalog.nearestResumeStep("nonexistent-step", []);
  assert.equal(next, "llm"); // first step in ONBOARDING_STEPS
});

test("nearestResumeStep skips already-completed steps from the resume point", () => {
  const completed = ["llm", "model"];
  const next = catalog.nearestResumeStep("llm", completed);
  // First step at-or-after llm that isn't in completed
  assert.equal(next, "search");
});

test("nearestResumeStep wraps to start when everything from the point is complete", () => {
  const allDone = catalog.ONBOARDING_STEPS.map(s => s.id);
  const next = catalog.nearestResumeStep("llm", allDone.slice(0, allDone.length - 1));
  // Only the last step is incomplete
  assert.equal(next, allDone[allDone.length - 1]);
});

test("isValidStepId accepts catalog ids and rejects others", () => {
  assert.equal(catalog.isValidStepId("llm"), true);
  assert.equal(catalog.isValidStepId("tool-keys"), true);
  assert.equal(catalog.isValidStepId("garbage"), false);
});

test("corrupt onboarding.json falls back to defaults instead of crashing", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const filePath = join(tmpHome, "agent", "onboarding.json");
  writeFileSync(filePath, "{ this is not json", "utf-8");
  const r = state.readOnboardingRecord();
  assert.equal(r.completedAt, null);
  assert.deepEqual(r.completedSteps, []);
});
