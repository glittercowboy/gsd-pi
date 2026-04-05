/**
 * Regression test for #3454: auto-dispatch must honour
 * require_slice_discussion preference and stop before plan-slice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("auto-dispatch has require_slice_discussion rule before plan-slice (#3454)", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "auto-dispatch.ts"),
    "utf-8",
  );
  const discussIdx = src.indexOf("require_slice_discussion");
  const planIdx = src.indexOf('"planning → plan-slice"');
  assert.ok(discussIdx !== -1, "auto-dispatch must check require_slice_discussion");
  assert.ok(discussIdx < planIdx, "Discussion check must come before plan-slice rule");
});
