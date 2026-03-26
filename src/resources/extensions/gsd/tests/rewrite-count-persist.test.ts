/**
 * Regression tests for #2203: rewrite-docs circuit breaker must persist
 * across session restarts.
 *
 * The rewrite attempt counter was stored in-memory on the session object,
 * resetting to 0 on every session restart. This allowed the rewrite-docs
 * dispatch rule to fire indefinitely, never tripping the MAX_REWRITE_ATTEMPTS
 * circuit breaker.
 *
 * The fix persists the counter to `.gsd/runtime/rewrite-count.json`.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getRewriteCount, setRewriteCount } from "../auto-dispatch.ts";

describe("rewrite-docs circuit breaker persistence (#2203)", () => {
  let tempBase: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "gsd-rewrite-test-"));
    // Create .gsd/ directory so gsdRoot resolves to it
    mkdirSync(join(tempBase, ".gsd", "runtime"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  test("getRewriteCount returns 0 when no file exists", () => {
    const count = getRewriteCount(tempBase);
    assert.equal(count, 0);
  });

  test("setRewriteCount writes and getRewriteCount reads back", () => {
    setRewriteCount(tempBase, 2);
    const count = getRewriteCount(tempBase);
    assert.equal(count, 2);
  });

  test("counter persists across simulated session restarts", () => {
    // Session 1: increment to 1
    setRewriteCount(tempBase, 1);

    // "Session restart" — only the disk file survives, session object is gone
    const countAfterRestart = getRewriteCount(tempBase);
    assert.equal(countAfterRestart, 1, "counter should survive session restart");

    // Session 2: increment to 2
    setRewriteCount(tempBase, countAfterRestart + 1);
    assert.equal(getRewriteCount(tempBase), 2);
  });

  test("setRewriteCount(0) resets the counter", () => {
    setRewriteCount(tempBase, 3);
    assert.equal(getRewriteCount(tempBase), 3);

    setRewriteCount(tempBase, 0);
    assert.equal(getRewriteCount(tempBase), 0);
  });

  test("getRewriteCount handles corrupt JSON gracefully", () => {
    const filePath = join(tempBase, ".gsd", "runtime", "rewrite-count.json");
    // writeFileSync is imported at the top of this file
    writeFileSync(filePath, "not json{{{");
    const count = getRewriteCount(tempBase);
    assert.equal(count, 0, "corrupt file should return 0");
  });

  test("rewrite-count.json is written to .gsd/runtime/", () => {
    setRewriteCount(tempBase, 1);
    const filePath = join(tempBase, ".gsd", "runtime", "rewrite-count.json");
    assert.ok(existsSync(filePath), "rewrite-count.json should exist");

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(content.count, 1);
    assert.ok(content.updatedAt, "should include timestamp");
  });
});
