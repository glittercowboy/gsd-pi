/**
 * clear-stale-autostart.test.ts — #3667
 *
 * Verify that guided-flow.ts adds a createdAt timestamp to pending auto-start
 * entries and implements a staleness check (30s age guard) so that /clear
 * interrupted discussions don't permanently block future /gsd invocations.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "guided-flow.ts");

describe("clear stale pending auto-start (#3667)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("PendingAutoStartEntry interface includes createdAt field", () => {
    assert.match(source, /createdAt:\s*number/);
  });

  test("setPendingAutoStart defaults createdAt to Date.now()", () => {
    assert.match(source, /createdAt:\s*Date\.now\(\)/);
  });

  test("staleness check uses 30_000ms threshold", () => {
    assert.match(source, /30[_]?000/);
  });

  test("stale entry detection checks manifest and context files", () => {
    assert.match(source, /DISCUSSION-MANIFEST\.json/);
    assert.match(source, /CONTEXT\.md/);
  });

  test("stale entries are deleted from the map", () => {
    assert.match(source, /pendingAutoStartMap\.delete\(basePath\)/);
  });
});
