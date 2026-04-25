/**
 * UOK gitops wiring — post-unit pre-verification policy.
 *
 * Tests the pure policy bit that selects the turn-level git action from
 * resolved UOK flags. The integration wiring (postUnitPreVerification
 * calling runTurnGitAction, writeTurnGitTransaction, the UokGateRunner
 * closeout pathway, and buildSnapshotOpts' trace/turn ID plumbing) is
 * exercised end-to-end by the auto-loop and UOK kernel integration tests;
 * the earlier source-grep assertions duplicated that coverage without
 * actually exercising the code, and have been removed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveUokFlags } from "../uok/flags.ts";

test("turn action defaults to commit when uok.gitops is enabled with no override", () => {
  const flags = resolveUokFlags({ uok: { gitops: { enabled: true } } } as any);
  assert.equal(flags.gitops, true);
  assert.equal(flags.gitopsTurnAction, "commit");
});

test("turn action reflects uok.gitops.turn_action when set to snapshot", () => {
  const flags = resolveUokFlags({
    uok: { gitops: { enabled: true, turn_action: "snapshot" } },
  } as any);
  assert.equal(flags.gitops, true);
  assert.equal(flags.gitopsTurnAction, "snapshot");
});

test("turn action reflects uok.gitops.turn_action when set to status-only", () => {
  const flags = resolveUokFlags({
    uok: { gitops: { enabled: true, turn_action: "status-only" } },
  } as any);
  assert.equal(flags.gitops, true);
  assert.equal(flags.gitopsTurnAction, "status-only");
});

test("turn_push flag round-trips through resolveUokFlags", () => {
  const on = resolveUokFlags({
    uok: { gitops: { enabled: true, turn_push: true } },
  } as any);
  const off = resolveUokFlags({
    uok: { gitops: { enabled: true, turn_push: false } },
  } as any);
  assert.equal(on.gitopsTurnPush, true);
  assert.equal(off.gitopsTurnPush, false);
});

test("gitops disabled when uok.gitops.enabled is explicitly false", () => {
  const flags = resolveUokFlags({
    uok: { gitops: { enabled: false, turn_action: "snapshot" } },
  } as any);
  assert.equal(flags.gitops, false);
  // Turn_action is still surfaced so callers can read their policy cleanly.
  assert.equal(flags.gitopsTurnAction, "snapshot");
});
