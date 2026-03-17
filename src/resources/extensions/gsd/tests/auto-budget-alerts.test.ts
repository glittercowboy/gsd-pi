import test from "node:test";
import assert from "node:assert/strict";

import {
  getBudgetAlertLevel,
  getBudgetEnforcementAction,
  getNewBudgetAlertLevel,
} from "../auto.js";

test("getBudgetAlertLevel returns the expected threshold bucket", () => {
  assert.equal(getBudgetAlertLevel(0.10), 0);
  assert.equal(getBudgetAlertLevel(0.74), 0);
  assert.equal(getBudgetAlertLevel(0.75), 75);
  assert.equal(getBudgetAlertLevel(0.79), 75);
  assert.equal(getBudgetAlertLevel(0.80), 80);
  assert.equal(getBudgetAlertLevel(0.85), 80);
  assert.equal(getBudgetAlertLevel(0.89), 80);
  assert.equal(getBudgetAlertLevel(0.90), 90);
  assert.equal(getBudgetAlertLevel(1.00), 100);
});

test("getNewBudgetAlertLevel only emits once per threshold", () => {
  assert.equal(getNewBudgetAlertLevel(0, 0.74), null);
  assert.equal(getNewBudgetAlertLevel(0, 0.75), 75);
  assert.equal(getNewBudgetAlertLevel(75, 0.79), null);
  assert.equal(getNewBudgetAlertLevel(75, 0.80), 80);
  assert.equal(getNewBudgetAlertLevel(80, 0.85), null);
  assert.equal(getNewBudgetAlertLevel(80, 0.90), 90);
  assert.equal(getNewBudgetAlertLevel(90, 0.95), null);
  assert.equal(getNewBudgetAlertLevel(90, 1.0), 100);
  assert.equal(getNewBudgetAlertLevel(100, 1.2), null);
});

test("80% alert fires exactly once between 75% and 90%", () => {
  // Transition from 75 → 80 emits 80
  assert.equal(getNewBudgetAlertLevel(75, 0.80), 80);
  // Already at 80 — no re-emission
  assert.equal(getNewBudgetAlertLevel(80, 0.82), null);
  assert.equal(getNewBudgetAlertLevel(80, 0.89), null);
  // Transition from 80 → 90 emits 90
  assert.equal(getNewBudgetAlertLevel(80, 0.90), 90);
});

test("getBudgetEnforcementAction maps the configured ceiling behavior", () => {
  assert.equal(getBudgetEnforcementAction("warn", 0.80), "none");
  assert.equal(getBudgetEnforcementAction("warn", 0.99), "none");
  assert.equal(getBudgetEnforcementAction("warn", 1.0), "warn");
  assert.equal(getBudgetEnforcementAction("pause", 1.0), "pause");
  assert.equal(getBudgetEnforcementAction("halt", 1.0), "halt");
});
