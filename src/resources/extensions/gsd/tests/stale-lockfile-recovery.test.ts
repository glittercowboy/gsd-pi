/**
 * stale-lockfile-recovery.test.ts — #3668
 *
 * Verify that session-lock.ts contains pre-flight stale lock cleanup logic
 * that removes orphaned lock directories when the owning PID is dead,
 * preventing the 30-min stale window from blocking /gsd after crashes.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "session-lock.ts");

describe("stale lockfile auto-recovery (#3668)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("checks for orphan lock with isPidAlive", () => {
    assert.match(source, /isPidAlive\(existingData\.pid\)/);
  });

  test("removes stale lock directory with rmSync", () => {
    assert.match(source, /rmSync\(lockDir,\s*\{\s*recursive:\s*true/);
  });

  test("references issue #3218 in pre-flight cleanup comment", () => {
    assert.match(source, /#3218.*Pre-flight stale lock cleanup/);
  });

  test("provides actionable rm -rf workaround in error message", () => {
    assert.match(source, /rm\s+-rf/);
  });
});
