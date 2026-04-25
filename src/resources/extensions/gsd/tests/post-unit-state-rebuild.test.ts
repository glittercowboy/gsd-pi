/**
 * Regression test for #3869: normal post-unit flow should rebuild STATE.md
 * before syncing worktree state back to the project root.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "..", "auto-post-unit.ts"), "utf-8");

test("auto-post-unit imports rebuildState", () => {
  assert.ok(
    source.includes('import { rebuildState } from "./doctor.js";'),
    "auto-post-unit.ts should import rebuildState from doctor.ts",
  );
});

test("postUnitPreVerification rebuilds STATE.md before worktree sync", () => {
  const fnStart = source.indexOf("export async function postUnitPreVerification");
  assert.ok(fnStart > 0, "postUnitPreVerification should exist");

  const fnEnd = source.indexOf("export async function postUnitPostVerification", fnStart);
  const section = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  const rebuildIdx = section.indexOf('await runSafely("postUnit", "state-rebuild"');
  const syncIdx = section.indexOf('await runSafely("postUnit", "worktree-sync"');

  assert.ok(rebuildIdx > 0, "postUnitPreVerification should rebuild STATE.md after unit completion");
  assert.ok(syncIdx > 0, "postUnitPreVerification should sync worktree state back to the project root");
  assert.ok(
    rebuildIdx < syncIdx,
    "STATE.md rebuild should happen before worktree sync so synced state is fresh",
  );
});
