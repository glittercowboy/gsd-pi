/**
 * auto-compaction-paused.test.ts — Regression for #3165.
 *
 * When auto-mode is paused (isAutoPaused() === true, isAutoActive() === false),
 * the session_before_compact handler must NOT return { cancel: true }.
 * Only an actively running auto-mode (isAutoActive() === true) should block compaction.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildBeforeCompactHandler } from "../bootstrap/register-hooks.ts";

// ─── Test 1: paused-only → compaction MUST proceed (#3165 regression) ───────

test("compaction proceeds when auto is paused but not active (#3165)", async () => {
  const isAutoActive = () => false;
  const isAutoPaused = () => true;

  const handler = buildBeforeCompactHandler(isAutoActive, isAutoPaused);
  const result = await handler();

  assert.notDeepEqual(
    result,
    { cancel: true },
    "paused-but-not-active auto-mode must not block compaction",
  );
});

// ─── Test 2: active auto-mode → compaction MUST be blocked ──────────────────

test("compaction is blocked when auto is actively running", async () => {
  const isAutoActive = () => true;
  const isAutoPaused = () => false;

  const handler = buildBeforeCompactHandler(isAutoActive, isAutoPaused);
  const result = await handler();

  assert.deepEqual(
    result,
    { cancel: true },
    "active auto-mode must block compaction",
  );
});

// ─── Test 3: idle (both false) → compaction MUST proceed ────────────────────

test("compaction proceeds when auto-mode is completely idle", async () => {
  const isAutoActive = () => false;
  const isAutoPaused = () => false;

  const handler = buildBeforeCompactHandler(isAutoActive, isAutoPaused);
  const result = await handler();

  assert.notDeepEqual(
    result,
    { cancel: true },
    "idle auto-mode must not block compaction",
  );
});
