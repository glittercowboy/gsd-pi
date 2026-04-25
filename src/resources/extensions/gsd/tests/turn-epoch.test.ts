// Project: gsd-pi — Tests for the auto/turn-epoch stale-write guard.

import test from "node:test";
import assert from "node:assert/strict";

import {
  _resetTurnEpoch,
  bumpTurnGeneration,
  describeTurnEpoch,
  getCurrentTurnGeneration,
  isStaleWrite,
  runWithTurnGeneration,
} from "../auto/turn-epoch.ts";

test("turn-epoch: generation starts at 0 and bumps monotonically", () => {
  _resetTurnEpoch();
  assert.equal(getCurrentTurnGeneration(), 0);
  assert.equal(bumpTurnGeneration("test-a"), 1);
  assert.equal(bumpTurnGeneration("test-b"), 2);
  assert.equal(getCurrentTurnGeneration(), 2);
});

test("turn-epoch: isStaleWrite returns false when no turn context captured", () => {
  _resetTurnEpoch();
  bumpTurnGeneration("no-context");
  // Called outside runWithTurnGeneration — safe default is false.
  assert.equal(isStaleWrite("out-of-band"), false);
});

test("turn-epoch: isStaleWrite returns false inside a fresh turn", () => {
  _resetTurnEpoch();
  const captured = getCurrentTurnGeneration();
  runWithTurnGeneration(captured, () => {
    assert.equal(isStaleWrite("fresh"), false);
  });
});

test("turn-epoch: isStaleWrite returns true after the epoch bumps mid-turn", () => {
  _resetTurnEpoch();
  const captured = getCurrentTurnGeneration();
  runWithTurnGeneration(captured, () => {
    bumpTurnGeneration("recovery-fires");
    assert.equal(isStaleWrite("stale"), true);
  });
});

test("turn-epoch: nested turns each see their own captured generation", () => {
  _resetTurnEpoch();
  const outerGen = getCurrentTurnGeneration();
  runWithTurnGeneration(outerGen, () => {
    assert.equal(isStaleWrite("outer-fresh"), false);
    bumpTurnGeneration("bump-between");
    const innerGen = getCurrentTurnGeneration();
    runWithTurnGeneration(innerGen, () => {
      // Inner context saw the bumped generation at capture time — fresh.
      assert.equal(isStaleWrite("inner-fresh"), false);
    });
    // Back to outer context — still stale because outerGen < current.
    assert.equal(isStaleWrite("outer-after-bump"), true);
  });
});

test("turn-epoch: describeTurnEpoch surfaces captured vs current", () => {
  _resetTurnEpoch();
  bumpTurnGeneration("seed");
  const captured = getCurrentTurnGeneration();
  runWithTurnGeneration(captured, () => {
    let snapshot = describeTurnEpoch();
    assert.equal(snapshot.captured, captured);
    assert.equal(snapshot.current, captured);
    assert.equal(snapshot.stale, false);

    bumpTurnGeneration("supersede");
    snapshot = describeTurnEpoch();
    assert.equal(snapshot.captured, captured);
    assert.equal(snapshot.current, captured + 1);
    assert.equal(snapshot.stale, true);
  });

  // Outside the turn — captured is null, stale is false.
  const outside = describeTurnEpoch();
  assert.equal(outside.captured, null);
  assert.equal(outside.stale, false);
});

test("turn-epoch: AsyncLocalStorage propagates across awaits", async () => {
  _resetTurnEpoch();
  const captured = getCurrentTurnGeneration();
  await runWithTurnGeneration(captured, async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    bumpTurnGeneration("async-bump");
    await Promise.resolve();
    assert.equal(isStaleWrite("post-await"), true);
  });
});

// ─── Source-level invariant checks for recoverTimedOutUnit ──────────────────
//
// The recoverTimedOutUnit function has two branch families:
// - ADVANCE branches: the unit is done, loop moves on — these MUST bump.
// - STEERING branches: the same LLM turn is kept alive with a steering
//   message — these MUST NOT bump (otherwise the retry's legitimate writes
//   get marked stale).
//
// The whole function must contain zero raw `resolveAgentEnd` calls with the
// "timeout-recovery" _synthetic marker — all advance paths go through
// bumpAndResolveSynthetic. And there must be no top-level bump call.

test("recoverTimedOutUnit: no raw `resolveAgentEnd({ _synthetic: \"timeout-recovery\" })` calls remain", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "..", "auto-timeout-recovery.ts"),
    "utf-8",
  );
  const rawSyntheticResolve =
    /resolveAgentEnd\s*\(\s*\{\s*messages:\s*\[\s*\]\s*,\s*_synthetic:\s*["']timeout-recovery/;
  assert.equal(
    rawSyntheticResolve.test(src),
    false,
    "auto-timeout-recovery.ts must funnel advance paths through bumpAndResolveSynthetic — a raw resolveAgentEnd with _synthetic:\"timeout-recovery\" would leak orphan writes",
  );
});

test("recoverTimedOutUnit: no top-level bumpTurnGeneration — steering branches must not supersede", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "..", "auto-timeout-recovery.ts"),
    "utf-8",
  );
  // The only bump surface allowed is via bumpAndResolveSynthetic (advance
  // paths) — a direct bumpTurnGeneration call in this file would bump even
  // when the function later decides to take a steering retry branch.
  assert.equal(
    /\bbumpTurnGeneration\s*\(/.test(src),
    false,
    "auto-timeout-recovery.ts must not call bumpTurnGeneration directly — use bumpAndResolveSynthetic so bump and supersede are atomic and tied to advance-only branches",
  );
});

test("recoverTimedOutUnit: bumpAndResolveSynthetic appears exactly four times (one per advance branch)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "..", "auto-timeout-recovery.ts"),
    "utf-8",
  );
  const matches = src.match(/bumpAndResolveSynthetic\s*\(/g) ?? [];
  assert.equal(
    matches.length,
    4,
    `expected 4 advance-branch supersede sites (durableComplete, execute-task-exhausted, artifact-already-exists, non-execute-exhausted); found ${matches.length}`,
  );
});
