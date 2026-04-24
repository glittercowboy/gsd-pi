/**
 * Worker model override — tests for parallel.worker_model preference.
 *
 * Verifies validation accepts/rejects values and that resolveParallelConfig
 * passes worker_model through from the raw preferences object.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validatePreferences } from "../preferences-validation.ts";
import { resolveParallelConfig } from "../preferences.ts";

test("validatePreferences accepts valid worker_model string", () => {
  const { preferences, errors } = validatePreferences({
    parallel: { enabled: true, worker_model: "claude-3-5-sonnet" },
  } as any);
  assert.equal(errors.length, 0, `no errors expected, got ${JSON.stringify(errors)}`);
  assert.equal(preferences.parallel?.worker_model, "claude-3-5-sonnet");
});

test("validatePreferences rejects empty worker_model with explicit error", () => {
  const { errors } = validatePreferences({
    parallel: { enabled: true, worker_model: "" },
  } as any);
  assert.ok(
    errors.some((e) => e.includes("parallel.worker_model") && e.includes("non-empty")),
    `expected error mentioning parallel.worker_model, got ${JSON.stringify(errors)}`,
  );
});

test("validatePreferences rejects non-string worker_model", () => {
  const { errors } = validatePreferences({
    parallel: { enabled: true, worker_model: 42 },
  } as any);
  assert.ok(
    errors.some((e) => e.includes("parallel.worker_model")),
    `expected error mentioning parallel.worker_model, got ${JSON.stringify(errors)}`,
  );
});

test("resolveParallelConfig passes worker_model through", () => {
  const cfg = resolveParallelConfig({
    parallel: { enabled: true, worker_model: "opus-4.7" },
  } as any);
  assert.equal(cfg.worker_model, "opus-4.7");
});

test("resolveParallelConfig leaves worker_model undefined when absent", () => {
  const cfg = resolveParallelConfig({ parallel: { enabled: true } } as any);
  assert.equal(cfg.worker_model, undefined);
});

test("resolveParallelConfig handles undefined prefs (worker_model undefined)", () => {
  const cfg = resolveParallelConfig(undefined);
  assert.equal(cfg.worker_model, undefined);
});
