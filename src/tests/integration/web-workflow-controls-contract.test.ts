import test from "node:test";
import assert from "node:assert/strict";

// ─── Import ──────────────────────────────────────────────────────────
const { deriveWorkflowAction } = await import("../../web/lib/workflow-actions.ts");

// ─── Helpers ──────────────────────────────────────────────────────────
function baseInput(overrides: Partial<Parameters<typeof deriveWorkflowAction>[0]> = {}) {
  return {
    phase: "executing" as string,
    autoActive: false,
    autoPaused: false,
    onboardingLocked: false,
    commandInFlight: null as string | null,
    bootStatus: "ready" as string,
    hasMilestones: true,
    ...overrides,
  };
}

// ─── Group 1: Phase → action mapping ──────────────────────────────────
test("planning + no auto → primary is /gsd with label Plan", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "planning" }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd");
  assert.equal(result.primary.label, "Plan");
  assert.equal(result.primary.variant, "default");
  assert.equal(result.disabled, false);
});

test("executing + no auto → primary is /gsd auto with label Start Auto", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "executing" }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd auto");
  assert.equal(result.primary.label, "Start Auto");
});

test("summarizing + no auto → primary is /gsd auto with label Start Auto", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "summarizing" }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd auto");
  assert.equal(result.primary.label, "Start Auto");
});

test("auto active (not paused) → primary is /gsd stop with destructive variant", () => {
  const result = deriveWorkflowAction(baseInput({ autoActive: true, autoPaused: false }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd stop");
  assert.equal(result.primary.label, "Stop Auto");
  assert.equal(result.primary.variant, "destructive");
});

test("auto paused → primary is /gsd auto with label Resume Auto", () => {
  const result = deriveWorkflowAction(baseInput({ autoPaused: true }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd auto");
  assert.equal(result.primary.label, "Resume Auto");
  assert.equal(result.primary.variant, "default");
});

test("pre-planning + no milestones → primary is /gsd with label Initialize Project", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "pre-planning", hasMilestones: false }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd");
  assert.equal(result.primary.label, "Initialize Project");
});

test("pre-planning + has milestones → primary is /gsd with label Continue", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "pre-planning", hasMilestones: true }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd");
  assert.equal(result.primary.label, "Continue");
});

test("other phases (e.g. researching) without auto → primary is Continue /gsd", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "researching" }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd");
  assert.equal(result.primary.label, "Continue");
});

test("verifying phase without auto → primary is Continue /gsd", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "verifying" }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd");
  assert.equal(result.primary.label, "Continue");
});

test("complete phase without auto → primary is New Milestone /gsd with no step secondary", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "complete" }));
  assert.ok(result.primary);
  assert.equal(result.primary.command, "/gsd");
  assert.equal(result.primary.label, "New Milestone");
  assert.equal(result.isNewMilestone, true);
  assert.deepEqual(result.secondaries, []);
});

// ─── Group 2: Secondary actions ───────────────────────────────────────
test("secondaries include Step when auto is not active", () => {
  const result = deriveWorkflowAction(baseInput({ phase: "executing" }));
  assert.ok(result.secondaries.length > 0);
  const step = result.secondaries.find((s) => s.command === "/gsd next");
  assert.ok(step, "Expected a Step secondary action");
  assert.equal(step.label, "Step");
});

test("no secondaries when auto is active", () => {
  const result = deriveWorkflowAction(baseInput({ autoActive: true }));
  assert.equal(result.secondaries.length, 0);
});

test("no secondaries when auto is paused", () => {
  const result = deriveWorkflowAction(baseInput({ autoPaused: true }));
  assert.equal(result.secondaries.length, 0);
});

// ─── Group 3: Disabled conditions ─────────────────────────────────────
test("commandInFlight non-null → disabled with reason", () => {
  const result = deriveWorkflowAction(baseInput({ commandInFlight: "prompt" }));
  assert.equal(result.disabled, true);
  assert.equal(result.disabledReason, "Command in progress");
});

test("bootStatus not ready → disabled with reason", () => {
  const result = deriveWorkflowAction(baseInput({ bootStatus: "loading" }));
  assert.equal(result.disabled, true);
  assert.equal(result.disabledReason, "Workspace not ready");
});

test("bootStatus error → disabled with reason", () => {
  const result = deriveWorkflowAction(baseInput({ bootStatus: "error" }));
  assert.equal(result.disabled, true);
  assert.equal(result.disabledReason, "Workspace not ready");
});

test("onboardingLocked → disabled with reason", () => {
  const result = deriveWorkflowAction(baseInput({ onboardingLocked: true }));
  assert.equal(result.disabled, true);
  assert.equal(result.disabledReason, "Setup required");
});

test("all conditions met → not disabled", () => {
  const result = deriveWorkflowAction(baseInput());
  assert.equal(result.disabled, false);
  assert.equal(result.disabledReason, undefined);
});

// ─── Group 4: Disabled priority ───────────────────────────────────────
test("commandInFlight takes priority over bootStatus", () => {
  const result = deriveWorkflowAction(baseInput({ commandInFlight: "prompt", bootStatus: "loading" }));
  assert.equal(result.disabledReason, "Command in progress");
});

test("bootStatus takes priority over onboardingLocked", () => {
  const result = deriveWorkflowAction(baseInput({ bootStatus: "loading", onboardingLocked: true }));
  assert.equal(result.disabledReason, "Workspace not ready");
});
