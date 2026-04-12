import test from "node:test";
import assert from "node:assert/strict";

import {
  IDLE_TIMEOUT_MS,
  NEW_MILESTONE_IDLE_TIMEOUT_MS,
  getHeadlessIdleTimeout,
  shouldArmIdleTimeout,
} from "../headless-events.js";

test("getHeadlessIdleTimeout disables idle fallback for auto-mode (#3428)", () => {
  assert.equal(getHeadlessIdleTimeout("auto"), 0);
});

test("getHeadlessIdleTimeout keeps extended timeout for new-milestone", () => {
  assert.equal(getHeadlessIdleTimeout("new-milestone"), NEW_MILESTONE_IDLE_TIMEOUT_MS);
});

test("getHeadlessIdleTimeout keeps default timeout for ordinary commands", () => {
  assert.equal(getHeadlessIdleTimeout("next"), IDLE_TIMEOUT_MS);
});

test("shouldArmIdleTimeout requires both tool activity and a positive timeout", () => {
  assert.equal(shouldArmIdleTimeout(0, IDLE_TIMEOUT_MS), false);
  assert.equal(shouldArmIdleTimeout(1, 0), false);
  assert.equal(shouldArmIdleTimeout(2, IDLE_TIMEOUT_MS), true);
});
