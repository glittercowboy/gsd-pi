/**
 * Tests for test-helpers.ts — the source-inspection and timing helpers
 * introduced in #4773 / #4774 to replace brittle fixed-byte slice and
 * magic-number sleep patterns in the test suite.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractSourceRegion, waitForCondition, findLine } from "./test-helpers.ts";

// ─── extractSourceRegion ──────────────────────────────────────────────────

test("extractSourceRegion returns empty string when start anchor missing", () => {
  assert.equal(extractSourceRegion("const x = 1;", "missing"), "");
});

test("extractSourceRegion uses explicit end anchor when provided", () => {
  const src = "START_TOKEN\nbody line\nEND_TOKEN tail";
  const region = extractSourceRegion(src, "START_TOKEN", "END_TOKEN");
  assert.ok(region.includes("START_TOKEN"));
  assert.ok(region.includes("body line"));
  assert.ok(!region.includes("END_TOKEN"));
});

test("extractSourceRegion stops at next private method boundary", () => {
  const src = [
    "class Foo {",
    "  private alpha(): void {",
    "    const a = 1;",
    "    someCall();",
    "  }",
    "",
    "  private beta(): void {",
    "    const b = 2;",
    "  }",
    "}",
  ].join("\n");

  // Anchor on alpha's declaration; helper should stop at the next
  // private method (beta), not on alpha itself.
  const region = extractSourceRegion(src, "private alpha");
  assert.ok(region.includes("alpha"));
  assert.ok(region.includes("someCall()"));
  assert.ok(!region.includes("beta"));
});

test("extractSourceRegion stops at next top-level function", () => {
  const src = [
    "function alpha() {",
    "  throw new Error('alpha');",
    "}",
    "",
    "function beta() {",
    "  return 2;",
    "}",
  ].join("\n");

  const region = extractSourceRegion(src, "function alpha");
  assert.ok(region.includes("throw new Error"));
  assert.ok(!region.includes("beta"));
});

test("extractSourceRegion returns to end-of-source when no terminator found", () => {
  const src = "just one line";
  assert.equal(extractSourceRegion(src, "just"), "just one line");
});

// ─── waitForCondition ─────────────────────────────────────────────────────

test("waitForCondition returns immediately when condition is true", async () => {
  const result = await waitForCondition(() => true);
  assert.equal(result, true);
});

test("waitForCondition waits and returns when condition becomes true", async () => {
  let flipped = false;
  setTimeout(() => { flipped = true; }, 30);
  const result = await waitForCondition(() => flipped, { intervalMs: 5 });
  assert.equal(result, true);
});

test("waitForCondition throws after timeout with description", async () => {
  await assert.rejects(
    waitForCondition(() => false, { timeoutMs: 50, intervalMs: 5, description: "the flag to flip" }),
    /waiting for the flag to flip/i,
  );
});

test("waitForCondition surfaces last error on timeout", async () => {
  await assert.rejects(
    waitForCondition(
      () => { throw new Error("probe failed"); },
      { timeoutMs: 30, intervalMs: 5, description: "probe" },
    ),
    /probe failed/,
  );
});

test("waitForCondition returns the truthy value (not just true)", async () => {
  let n = 0;
  const result = await waitForCondition(() => {
    n++;
    return n >= 3 ? { ready: true, iteration: n } : null;
  }, { intervalMs: 5 });
  // The helper only resolves when the condition returns a truthy value, so
  // result cannot be null here. Assert it and narrow for the follow-ups.
  assert.ok(result, "waitForCondition must resolve with a truthy value, not null");
  assert.equal(result.ready, true);
  assert.equal(result.iteration, 3);
});

// ─── findLine ─────────────────────────────────────────────────────────────

test("findLine locates a line by regex", () => {
  const output = "header\nstatus: ok\nfooter";
  const match = findLine(output, /^status:/);
  assert.equal(match.index, 1);
  assert.equal(match.text, "status: ok");
});

test("findLine locates a line by predicate", () => {
  const output = "a\nb\nc";
  const match = findLine(output, (l) => l === "b");
  assert.equal(match.index, 1);
  assert.equal(match.text, "b");
});

test("findLine throws with preview when no line matches", () => {
  assert.throws(
    () => findLine("a\nb\nc", /NOTFOUND/),
    /First 10 lines/,
  );
});

test("findLine resets lastIndex between lines for /g regex patterns", () => {
  // Without the reset, RegExp.test with /g flag stateful-advances lastIndex
  // and can skip matches on subsequent calls. Verify the reset keeps
  // per-line testing deterministic.
  const output = "foo\nfoo\nfoo";
  const globalRe = /foo/g;
  const match = findLine(output, globalRe);
  assert.equal(match.index, 0);
  // Second call on the same pattern must also match — would fail without reset
  const match2 = findLine(output, globalRe);
  assert.equal(match2.index, 0);
});
