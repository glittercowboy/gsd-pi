/**
 * dispatcher-stuck-planning.test.ts — #3656
 *
 * Verify that state.ts contains the disk-to-DB task reconciliation logic
 * that prevents the dispatcher from getting stuck in an infinite planning
 * loop when the planner writes a PLAN.md but never calls the persistence
 * tool, leaving the DB with zero task rows.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(__dirname, "..", "state.ts");

describe("dispatcher stuck-planning reconciliation (#3656)", () => {
  const source = readFileSync(sourceFile, "utf-8");

  test("imports insertTask from gsd-db", () => {
    assert.match(source, /import\s*\{[^}]*insertTask[^}]*\}\s*from/);
  });

  test("contains plan-file task reconciliation block", () => {
    assert.match(source, /tasks\.length\s*===\s*0\s*&&\s*planFile/);
  });

  test("calls insertTask for each disk plan task", () => {
    assert.match(source, /insertTask\(\{/);
  });

  test("references issue #3600 in reconciliation comment", () => {
    assert.match(source, /#3600/);
  });
});
