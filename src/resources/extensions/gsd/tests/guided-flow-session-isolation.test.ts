/**
 * Regression test for #2985 Bugs 3 & 4:
 *   Bug 3 — module-level pendingAutoStart singleton clobbers concurrent sessions.
 *   Bug 4 — getDiscussionMilestoneId() returns wrong project's milestone under concurrency.
 *
 * pendingAutoStart must be keyed by basePath so concurrent discuss sessions
 * in different projects are independent.  getDiscussionMilestoneId() must accept
 * a basePath parameter to perform a keyed lookup.
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getDiscussionMilestoneId,
  setPendingAutoStart,
  clearPendingAutoStart,
} from "../guided-flow.ts";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("#2985 Bug 3 — concurrent discuss sessions must be independent", () => {
  beforeEach(() => {
    clearPendingAutoStart();
  });

  test("second session does not clobber first session's pending auto-start", () => {
    // Simulate two concurrent discuss sessions for different projects
    const projectA = "/projects/alpha";
    const projectB = "/projects/beta";

    setPendingAutoStart(projectA, {
      basePath: projectA,
      milestoneId: "M001-aaa111",
    });

    setPendingAutoStart(projectB, {
      basePath: projectB,
      milestoneId: "M002-bbb222",
    });

    // Both sessions should be retrievable
    const milestoneA = getDiscussionMilestoneId(projectA);
    const milestoneB = getDiscussionMilestoneId(projectB);

    assert.equal(milestoneA, "M001-aaa111", "projectA's milestone should be preserved");
    assert.equal(milestoneB, "M002-bbb222", "projectB's milestone should be preserved");
  });

  test("clearing one session does not affect the other", () => {
    const projectA = "/projects/alpha";
    const projectB = "/projects/beta";

    setPendingAutoStart(projectA, { basePath: projectA, milestoneId: "M001-aaa111" });
    setPendingAutoStart(projectB, { basePath: projectB, milestoneId: "M002-bbb222" });

    // Clear only projectA
    clearPendingAutoStart(projectA);

    assert.equal(getDiscussionMilestoneId(projectA), null, "projectA should be cleared");
    assert.equal(getDiscussionMilestoneId(projectB), "M002-bbb222", "projectB should survive");
  });
});

describe("#2985 Bug 4 — getDiscussionMilestoneId must be keyed by basePath", () => {
  beforeEach(() => {
    clearPendingAutoStart();
  });

  test("getDiscussionMilestoneId(basePath) returns correct milestone for each project", () => {
    setPendingAutoStart("/proj/a", { basePath: "/proj/a", milestoneId: "M001" });
    setPendingAutoStart("/proj/b", { basePath: "/proj/b", milestoneId: "M002" });

    assert.equal(getDiscussionMilestoneId("/proj/a"), "M001");
    assert.equal(getDiscussionMilestoneId("/proj/b"), "M002");
    assert.equal(getDiscussionMilestoneId("/proj/unknown"), null);
  });

  test("getDiscussionMilestoneId() without basePath returns null when multiple sessions exist", () => {
    setPendingAutoStart("/proj/a", { basePath: "/proj/a", milestoneId: "M001" });
    setPendingAutoStart("/proj/b", { basePath: "/proj/b", milestoneId: "M002" });

    // Without a key, the function should not blindly return the first entry
    const result = getDiscussionMilestoneId();
    // When there's ambiguity (multiple sessions), it should return null
    // to force callers to be explicit
    assert.equal(result, null, "should not return arbitrary milestone when multiple sessions exist");
  });

  test("getDiscussionMilestoneId() without basePath returns the milestone when only one session", () => {
    setPendingAutoStart("/proj/a", { basePath: "/proj/a", milestoneId: "M001" });

    // With only one session, backward compat — return it
    const result = getDiscussionMilestoneId();
    assert.equal(result, "M001", "should return the only active milestone for backward compat");
  });
});
