/**
 * stale-slice-rows.test.ts — #3658
 *
 * Verify that state.ts contains slice-level status reconciliation that
 * updates stale DB rows (status "pending") when disk artifacts (SUMMARY)
 * prove the slice is complete. Without this, the dependency resolver builds
 * doneSliceIds from stale DB rows and downstream slices stay blocked.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "state.ts");

describe("stale slice row reconciliation (#3658)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("imports updateSliceStatus from gsd-db", () => {
    assert.match(source, /import\s*\{[^}]*updateSliceStatus[^}]*\}\s*from/);
  });

  test("checks isStatusDone before reconciling slice rows", () => {
    assert.match(source, /isStatusDone\(dbSlice\.status\)/);
  });

  test("resolves SUMMARY file to detect completed slices on disk", () => {
    assert.match(source, /resolveSliceFile\(basePath,\s*mid,\s*dbSlice\.id,\s*["']SUMMARY["']\)/);
  });

  test("calls updateSliceStatus to reconcile stale rows", () => {
    assert.match(source, /updateSliceStatus\(mid,\s*dbSlice\.id,\s*["']complete["']\)/);
  });

  test("references issue #3599 in reconciliation comment", () => {
    assert.match(source, /#3599/);
  });
});
