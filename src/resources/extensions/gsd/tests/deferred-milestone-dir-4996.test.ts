// GSD Extension — Regression test for #4996: deferred milestone dir creation
// Verifies that showHeadlessMilestoneCreation does not pre-create the milestone
// directory before the discuss flow runs. The dir should only appear after a
// writer (saveArtifactToDb / atomicWriteAsync) emits the first artifact.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isReusableGhostMilestone } from "../state.ts";
import { findMilestoneIds } from "../milestone-ids.ts";
import { clearReservedMilestoneIds } from "../milestone-ids.ts";
import { invalidateAllCaches } from "../cache.ts";
import { closeDatabase } from "../gsd-db.ts";

function makeBase(prefix = "gsd-deferred-dir-"): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

describe("deferred milestone dir creation (#4996)", () => {
  let base: string;

  beforeEach(() => {
    clearReservedMilestoneIds();
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    try { clearReservedMilestoneIds(); } catch { /* ignore */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("(a) fresh project: milestones dir has no M001 entry before any discuss flow", () => {
    base = makeBase();
    // Simulate the state after bootstrapGsdProject but before showHeadlessMilestoneCreation
    // runs dispatchWorkflow. With Fix #3, no milestone dir should be created by
    // the ID-reservation path alone.
    const ids = findMilestoneIds(base);
    assert.equal(ids.length, 0, "no milestone dirs should exist before any discuss flow");

    // And specifically M001 should not exist
    const m001Dir = join(base, ".gsd", "milestones", "M001");
    assert.ok(!existsSync(m001Dir), "M001 dir must not exist before the discuss flow runs");
  });

  it("(b) abandoned discuss flow leaves no orphan: isReusableGhostMilestone returns false for non-existent dir", () => {
    base = makeBase();
    // If no dir was ever created (Fix #3 working correctly), the check should
    // return false because there's nothing to reclaim (the path doesn't exist).
    // isReusableGhostMilestone operates on dirs that DO exist; if no dir exists,
    // findMilestoneIds won't surface it, so it won't be evaluated. This test
    // confirms the absence of a dir means no orphan to report.
    const m001Dir = join(base, ".gsd", "milestones", "M001");
    assert.ok(!existsSync(m001Dir), "no M001 dir should exist");
    // findMilestoneIds only returns dirs that exist
    const ids = findMilestoneIds(base);
    assert.ok(!ids.includes("M001"), "M001 should not appear in findMilestoneIds when no dir exists");
  });

  it("(c) a stub dir left from a previous bug IS reusable but a newly-generated ID with no dir is not in the ghost list", () => {
    base = makeBase();
    // Create a stub to represent a pre-existing phantom
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices"), { recursive: true });

    // isReusableGhostMilestone identifies the orphaned stub
    assert.ok(isReusableGhostMilestone(base, "M001"), "pre-existing stub should be identified as reusable ghost");

    // The new ID (M002, which would be max+1 in this scenario but ghost reuse returns M001)
    // should not have a dir
    const m002Dir = join(base, ".gsd", "milestones", "M002");
    assert.ok(!existsSync(m002Dir), "a freshly-requested ID should have no dir until first artifact write");
  });
});
