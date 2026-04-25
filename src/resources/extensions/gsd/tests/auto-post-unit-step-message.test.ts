// GSD-2 — Tests for step-mode completion messages in auto-post-unit

import test from "node:test";
import assert from "node:assert/strict";

import { buildStepCompleteMessage, STEP_COMPLETE_FALLBACK_MESSAGE } from "../auto-post-unit.ts";
import type { GSDState } from "../types.ts";

function makeState(overrides: Partial<GSDState>): GSDState {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

test("buildStepCompleteMessage: milestone complete surfaces review guidance", () => {
  const msg = buildStepCompleteMessage(makeState({ phase: "complete" }));
  assert.match(msg, /milestone finished/);
  assert.match(msg, /\/gsd status/);
  assert.doesNotMatch(msg, /Next:/);
});

test("buildStepCompleteMessage: mid-flight step includes next unit label and /clear hint", () => {
  const state = makeState({
    phase: "executing",
    activeSlice: { id: "S01", title: "Core" },
    activeTask: { id: "T03", title: "Wire notify" },
  });
  const msg = buildStepCompleteMessage(state);
  assert.match(msg, /Next: Execute T03: Wire notify/);
  assert.match(msg, /\/clear/);
  assert.match(msg, /\/gsd to continue/);
});

test("buildStepCompleteMessage: unknown phase falls back to generic continue label", () => {
  // Cast to bypass Phase union so we exercise the default branch of describeNextUnit.
  const state = makeState({ phase: "totally-unknown" as unknown as GSDState["phase"] });
  const msg = buildStepCompleteMessage(state);
  assert.match(msg, /Next: Continue/);
  assert.match(msg, /\/clear/);
});

test("STEP_COMPLETE_FALLBACK_MESSAGE: used when deriveState throws, still points users at /clear + /gsd", () => {
  assert.match(STEP_COMPLETE_FALLBACK_MESSAGE, /\/clear/);
  assert.match(STEP_COMPLETE_FALLBACK_MESSAGE, /\/gsd/);
});
