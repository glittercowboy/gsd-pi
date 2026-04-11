/**
 * dispatch-guard-closed-status.test.ts — #3653
 *
 * Verify that the dispatch guard uses isClosedStatus() instead of a raw
 * `status === "complete"` check when determining whether a slice is done.
 * Reconciled slices may carry statuses like "skipped" or "cancelled" which
 * are also closed — the raw check caused false dispatch blocks.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "dispatch-guard.ts");

describe("dispatch-guard isClosedStatus migration (#3653)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("imports isClosedStatus from status-guards", () => {
    assert.match(source, /import\s*\{[^}]*isClosedStatus[^}]*\}\s*from\s*["']\.\/status-guards/);
  });

  test("uses isClosedStatus() for slice done check instead of raw comparison", () => {
    assert.match(source, /done:\s*isClosedStatus\(r\.status\)/);
  });

  test("does not use raw status === 'complete' for DB slice rows", () => {
    assert.doesNotMatch(source, /done:\s*r\.status\s*===\s*["']complete["']/);
  });
});
