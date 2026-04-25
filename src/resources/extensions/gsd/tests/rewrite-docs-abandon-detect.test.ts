/**
 * Regression tests for #3490: post-unit handler for rewrite-docs must
 * detect abandon/descope overrides that target the current milestone and
 * park it — without false-positive parking on unrelated scope-change
 * overrides that merely contain an abandon-family verb.
 *
 * Exercises detectAbandonMilestone() directly — a pure function over
 * Override objects, no I/O and no production-code import chain.
 * parkMilestone() end-to-end behavior is covered by the existing
 * park-milestone.test.ts / park-edge-cases.test.ts / park-db-sync.test.ts
 * suites; here we only validate the decision layer that feeds it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectAbandonMilestone } from "../abandon-detect.ts";
import type { Override } from "../files.ts";

function mkOverride(change: string): Override {
  return {
    timestamp: "2026-04-21T00:00:00.000Z",
    change,
    scope: "active",
    appliedAt: "M001/S01/T01",
  };
}

describe("detectAbandonMilestone (#3490)", () => {
  test("parks on explicit abandon-milestone phrasing", () => {
    const d = detectAbandonMilestone(
      [mkOverride("abandon this milestone, it's no longer relevant")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
    assert.strictEqual(d.matched.length, 1);
    assert.match(d.reason, /abandon this milestone/);
  });

  test("parks on descope-milestone phrasing", () => {
    const d = detectAbandonMilestone(
      [mkOverride("descope the entire milestone")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
  });

  test("parks when override references milestone by ID instead of the word", () => {
    const d = detectAbandonMilestone(
      [mkOverride("shelve M003 for now, coming back next quarter")],
      "M003",
    );
    assert.strictEqual(d.shouldPark, true);
    assert.strictEqual(d.matched[0], "shelve M003 for now, coming back next quarter");
  });

  test("parks on past-tense / gerund verb forms (UK spelling)", () => {
    const d = detectAbandonMilestone(
      [mkOverride("this milestone was cancelled by product")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
  });

  test("parks on US spelling 'canceled' (single-l)", () => {
    const d = detectAbandonMilestone(
      [mkOverride("the milestone was canceled by the PM")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
  });

  test("parks on hyphenated 'de-scope' variant", () => {
    const d = detectAbandonMilestone(
      [mkOverride("de-scope this milestone — moved to v2")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
  });

  test("parks on space-separated 'de scope' variant", () => {
    const d = detectAbandonMilestone(
      [mkOverride("de scope the milestone entirely")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
  });

  test("parks on 'de-scoped' past-tense hyphen variant", () => {
    const d = detectAbandonMilestone(
      [mkOverride("M003 was de-scoped last week")],
      "M003",
    );
    assert.strictEqual(d.shouldPark, true);
  });

  // ─── False-positive guards ────────────────────────────────────────────

  test("does NOT park on 'cancel the standup reminder' (no milestone ref)", () => {
    const d = detectAbandonMilestone(
      [mkOverride("cancel the daily standup reminder")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, false);
    assert.deepStrictEqual(d.matched, []);
  });

  test("does NOT park on 'drop the dependency on X' (no milestone ref)", () => {
    const d = detectAbandonMilestone(
      [mkOverride("drop the dependency on X and use Y instead")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, false);
  });

  test("does NOT park on 'scrap the v1 design' (no milestone ref)", () => {
    const d = detectAbandonMilestone(
      [mkOverride("scrap the v1 design for the landing page")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, false);
  });

  test("does NOT park on override with milestone word but no abandon verb", () => {
    const d = detectAbandonMilestone(
      [mkOverride("change the milestone title to something clearer")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, false);
  });

  test("does NOT park when a different milestone ID is referenced", () => {
    // The abandon verb is present and an MID is present, but the MID is
    // not the current milestone. We require either the literal word
    // "milestone" OR the current MID — a reference to a different MID
    // (M007) with neither the word "milestone" nor the current ID (M001)
    // should not trigger.
    const d = detectAbandonMilestone(
      [mkOverride("drop M007")],
      "M001",
    );
    assert.strictEqual(d.shouldPark, false);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  test("empty overrides list returns no-park", () => {
    const d = detectAbandonMilestone([], "M001");
    assert.strictEqual(d.shouldPark, false);
    assert.deepStrictEqual(d.matched, []);
  });

  test("null/undefined currentMilestoneId returns no-park even with matching text", () => {
    const d1 = detectAbandonMilestone(
      [mkOverride("abandon this milestone")],
      null,
    );
    assert.strictEqual(d1.shouldPark, false);

    const d2 = detectAbandonMilestone(
      [mkOverride("abandon this milestone")],
      undefined,
    );
    assert.strictEqual(d2.shouldPark, false);
  });

  test("multiple abandon overrides are concatenated in reason", () => {
    const d = detectAbandonMilestone(
      [
        mkOverride("abandon this milestone"),
        mkOverride("cancel the standup"),           // filtered out (no ref)
        mkOverride("descope the milestone entirely"),
      ],
      "M001",
    );
    assert.strictEqual(d.shouldPark, true);
    assert.strictEqual(d.matched.length, 2, "only the two milestone-scoped overrides match");
    assert.match(d.reason, /abandon this milestone/);
    assert.match(d.reason, /descope the milestone entirely/);
    assert.doesNotMatch(d.reason, /cancel the standup/);
  });

  // ─── Regex-injection guard on milestone ID ────────────────────────────

  test("milestone ID with regex metacharacters is escaped, not interpreted", () => {
    // A pathological MID should not break the matcher — the function
    // escapes regex metacharacters before building the pattern.
    const d = detectAbandonMilestone(
      [mkOverride("abandon M.01 the milestone")],
      "M.01",
    );
    // 'milestone' is present, so this parks regardless of escaping,
    // but the test confirms the RegExp construction does not throw.
    assert.strictEqual(d.shouldPark, true);
  });
});

