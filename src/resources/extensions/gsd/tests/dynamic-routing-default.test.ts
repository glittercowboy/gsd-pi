/**
 * Dynamic routing default — verifies routing is enabled by default.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { defaultRoutingConfig } from "../model-router.js";

test("defaultRoutingConfig returns enabled: true", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.enabled, true, "dynamic routing should be enabled by default");
});

test("defaultRoutingConfig enables all routing features", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.escalate_on_failure, true);
  assert.equal(config.budget_pressure, true);
  assert.equal(config.cross_provider, true);
  assert.equal(config.hooks, true);
});
