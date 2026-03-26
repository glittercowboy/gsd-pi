/**
 * Regression test for #2488: Stale milestone ID reservations inflate next ID
 * after cancelled /gsd sessions.
 *
 * The module-level `reservedMilestoneIds` Set persists across /gsd invocations
 * within the same Node process. Without clearReservedMilestoneIds() at session
 * start, each cancelled session permanently bumps the counter by 1.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  nextMilestoneId,
  reserveMilestoneId,
  getReservedMilestoneIds,
  clearReservedMilestoneIds,
} from "../milestone-ids.ts";

describe("stale milestone ID reservation cleanup (#2488)", () => {
  beforeEach(() => {
    clearReservedMilestoneIds();
  });

  test("without cleanup, cancelled sessions inflate the next ID", () => {
    const diskIds = ["M001", "M002", "M003"];

    // Session 1: user starts /gsd, ID is previewed and reserved, then cancelled
    const allIds1 = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
    const preview1 = nextMilestoneId(allIds1);
    reserveMilestoneId(preview1);
    assert.equal(preview1, "M004");

    // Session 2: user starts /gsd again — stale reservation still in Set
    // WITHOUT clearing, the next ID skips M004 (reserved) and goes to M005
    const allIds2 = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
    const preview2 = nextMilestoneId(allIds2);
    assert.equal(preview2, "M005", "without cleanup, ID inflates to M005");
  });

  test("with cleanup at session start, next ID is correct", () => {
    const diskIds = ["M001", "M002", "M003"];

    // Session 1: user starts /gsd, ID is previewed and reserved, then cancelled
    const allIds1 = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
    const preview1 = nextMilestoneId(allIds1);
    reserveMilestoneId(preview1);
    assert.equal(preview1, "M004");

    // Session 2: clear stale reservations first (the fix)
    clearReservedMilestoneIds();

    // Now the next ID correctly returns M004 again
    const allIds2 = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
    const preview2 = nextMilestoneId(allIds2);
    assert.equal(preview2, "M004", "after cleanup, ID is correctly M004");
  });

  test("multiple cancelled sessions compound the inflation without cleanup", () => {
    const diskIds = ["M001", "M002", "M003"];

    // 3 cancelled sessions without cleanup
    for (let i = 0; i < 3; i++) {
      const allIds = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
      const preview = nextMilestoneId(allIds);
      reserveMilestoneId(preview);
    }

    // Without cleanup, we're now at M007 instead of M004
    const allIds = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
    const next = nextMilestoneId(allIds);
    assert.equal(next, "M007", "3 cancelled sessions inflate ID by 3");

    // With cleanup, we're back to M004
    clearReservedMilestoneIds();
    const allIdsClean = [...new Set([...diskIds, ...getReservedMilestoneIds()])];
    const nextClean = nextMilestoneId(allIdsClean);
    assert.equal(nextClean, "M004", "cleanup restores correct next ID");
  });
});
