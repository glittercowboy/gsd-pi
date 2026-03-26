import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
} from "../unit-runtime.ts";
import { clearPathCache } from '../paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const base = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-test-"));
const tasksDir = join(base, ".gsd", "milestones", "M100", "slices", "S02", "tasks");
mkdirSync(tasksDir, { recursive: true });
writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T09 for S02: do the thing\n", "utf-8");
writeFileSync(
  join(base, ".gsd", "milestones", "M100", "slices", "S02", "S02-PLAN.md"),
  "# S02: Test Slice\n\n## Tasks\n\n- [ ] **T09: Do the thing** `est:10m`\n  Description.\n",
  "utf-8",
);

console.log("\n=== runtime record write/read/update ===");
{
  const first = writeUnitRuntimeRecord(base, "execute-task", "M100/S02/T09", 1000, { phase: "dispatched" });
  assert.deepStrictEqual(first.phase, "dispatched", "initial phase");
  const second = writeUnitRuntimeRecord(base, "execute-task", "M100/S02/T09", 1000, { phase: "wrapup-warning-sent", wrapupWarningSent: true });
  assert.deepStrictEqual(second.wrapupWarningSent, true, "warning persisted");
  const loaded = readUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  assert.ok(loaded !== null, "record readable");
  assert.deepStrictEqual(loaded!.phase, "wrapup-warning-sent", "updated phase readable");
}

console.log("\n=== execute-task durability inspection ===");
{
  let status = await inspectExecuteTaskDurability(base, "M100/S02/T09");
  assert.ok(status !== null, "status exists");
  assert.deepStrictEqual(status!.summaryExists, false, "summary initially missing");
  assert.deepStrictEqual(status!.taskChecked, false, "task initially unchecked");
  assert.deepStrictEqual(status!.nextActionAdvanced, false, "next action initially stale");
  assert.ok(/summary missing/i.test(formatExecuteTaskRecoveryStatus(status!)), "diagnostic mentions summary");

  writeFileSync(join(tasksDir, "T09-SUMMARY.md"), "# done\n", "utf-8");
  writeFileSync(
    join(base, ".gsd", "milestones", "M100", "slices", "S02", "S02-PLAN.md"),
    "# S02: Test Slice\n\n## Tasks\n\n- [x] **T09: Do the thing** `est:10m`\n  Description.\n",
    "utf-8",
  );
  writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T10 for S02: next thing\n", "utf-8");
  clearPathCache();

  status = await inspectExecuteTaskDurability(base, "M100/S02/T09");
  assert.deepStrictEqual(status!.summaryExists, true, "summary found after write");
  assert.deepStrictEqual(status!.taskChecked, true, "task checked after update");
  assert.deepStrictEqual(status!.nextActionAdvanced, true, "next action advanced after update");
  assert.deepStrictEqual(formatExecuteTaskRecoveryStatus(status!), "all durable task artifacts present", "clean diagnostic when complete");
}

console.log("\n=== runtime record cleanup ===");
{
  clearUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  const loaded = readUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  assert.deepStrictEqual(loaded, null, "record removed");
}

console.log("\n=== hook unit type sanitization (slash in unitType) ===");
{
  // Hook units have unitType like "hook/code-review" with a slash
  // This should NOT create a subdirectory - the slash must be sanitized
  const hookRecord = writeUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10", 2000, { phase: "dispatched" });
  assert.deepStrictEqual(hookRecord.unitType, "hook/code-review", "unitType preserved in record");
  assert.deepStrictEqual(hookRecord.unitId, "M100/S02/T10", "unitId preserved in record");
  
  const loaded = readUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  assert.ok(loaded !== null, "hook record readable");
  assert.deepStrictEqual(loaded!.phase, "dispatched", "hook phase correct");
  
  // Verify the file is in the units dir, not in a subdirectory
  const unitsDir = join(base, ".gsd", "runtime", "units");
  const files = readdirSync(unitsDir);
  const hookFile = files.find((f: string) => f.includes("hook-code-review"));
  assert.ok(hookFile !== undefined, "hook file exists with sanitized name");
  assert.ok(!files.some((f: string) => f === "hook"), "no 'hook' subdirectory created");
  
  clearUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  const cleared = readUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  assert.deepStrictEqual(cleared, null, "hook record removed");
}

// ─── Must-have durability integration tests ───────────────────────────────

// Create a separate temp base for must-have tests to avoid interference
const mhBase = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-mh-test-"));

console.log("\n=== must-haves: all mentioned in summary ===");
{
  const tasksDir2 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S01", "tasks");
  mkdirSync(tasksDir2, { recursive: true });

  // Slice plan with T01 checked
  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S01", "S01-PLAN.md"),
    "# S01: Test\n\n## Tasks\n\n- [x] **T01: Build parser** `est:10m`\n  Build the parser.\n",
    "utf-8",
  );
  // Task plan with must-haves containing backtick code tokens
  writeFileSync(
    join(tasksDir2, "T01-PLAN.md"),
    "# T01: Build parser\n\n## Must-Haves\n\n- [ ] `parseWidget` function is exported\n- [ ] `formatWidget` handles edge cases\n- [ ] All existing tests pass\n\n## Steps\n\n1. Do stuff\n",
    "utf-8",
  );
  // Summary that mentions all must-haves
  writeFileSync(
    join(tasksDir2, "T01-SUMMARY.md"),
    "# T01: Build parser\n\nAdded parseWidget function and formatWidget with edge case handling. All existing tests pass without regression.\n",
    "utf-8",
  );
  // STATE.md with next action advanced past T01
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S01: next thing\n", "utf-8");

  const status = await inspectExecuteTaskDurability(mhBase, "M200/S01/T01");
  assert.ok(status !== null, "mh-all: status exists");
  assert.deepStrictEqual(status!.mustHaveCount, 3, "mh-all: mustHaveCount is 3");
  assert.deepStrictEqual(status!.mustHavesMentionedInSummary, 3, "mh-all: all 3 must-haves mentioned");
  assert.deepStrictEqual(status!.summaryExists, true, "mh-all: summary exists");
  assert.deepStrictEqual(status!.taskChecked, true, "mh-all: task checked");
  const diag = formatExecuteTaskRecoveryStatus(status!);
  assert.deepStrictEqual(diag, "all durable task artifacts present", "mh-all: diagnostic is clean when all must-haves met");
}

console.log("\n=== must-haves: partially mentioned in summary ===");
{
  const tasksDir3 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S02", "tasks");
  mkdirSync(tasksDir3, { recursive: true });

  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S02", "S02-PLAN.md"),
    "# S02: Test\n\n## Tasks\n\n- [x] **T01: Build thing** `est:10m`\n  Build.\n",
    "utf-8",
  );
  // Task plan with 3 must-haves, summary will only mention 1
  writeFileSync(
    join(tasksDir3, "T01-PLAN.md"),
    "# T01: Build thing\n\n## Must-Haves\n\n- [ ] `computeScore` function is exported\n- [ ] `validateInput` rejects invalid data\n- [ ] `renderOutput` handles empty arrays\n\n## Steps\n\n1. Do stuff\n",
    "utf-8",
  );
  // Summary only mentions computeScore
  writeFileSync(
    join(tasksDir3, "T01-SUMMARY.md"),
    "# T01: Build thing\n\nAdded computeScore function with full test coverage.\n",
    "utf-8",
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S02: next thing\n", "utf-8");

  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S02/T01");
  assert.ok(status !== null, "mh-partial: status exists");
  assert.deepStrictEqual(status!.mustHaveCount, 3, "mh-partial: mustHaveCount is 3");
  assert.deepStrictEqual(status!.mustHavesMentionedInSummary, 1, "mh-partial: only 1 must-have mentioned");
  const diag = formatExecuteTaskRecoveryStatus(status!);
  assert.ok(diag.includes("must-have gap"), "mh-partial: diagnostic includes 'must-have gap'");
  assert.ok(diag.includes("1 of 3"), "mh-partial: diagnostic includes '1 of 3'");
}

console.log("\n=== must-haves: no task plan file ===");
{
  const tasksDir4 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S03", "tasks");
  mkdirSync(tasksDir4, { recursive: true });

  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S03", "S03-PLAN.md"),
    "# S03: Test\n\n## Tasks\n\n- [x] **T01: Quick fix** `est:5m`\n  Fix.\n",
    "utf-8",
  );
  // No T01-PLAN.md — only summary
  writeFileSync(
    join(tasksDir4, "T01-SUMMARY.md"),
    "# T01: Quick fix\n\nFixed the thing.\n",
    "utf-8",
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S03: next thing\n", "utf-8");

  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S03/T01");
  assert.ok(status !== null, "mh-noplan: status exists");
  assert.deepStrictEqual(status!.mustHaveCount, 0, "mh-noplan: mustHaveCount is 0 when no task plan");
  assert.deepStrictEqual(status!.mustHavesMentionedInSummary, 0, "mh-noplan: mustHavesMentionedInSummary is 0");
}

console.log("\n=== must-haves: present but no summary file ===");
{
  const tasksDir5 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S04", "tasks");
  mkdirSync(tasksDir5, { recursive: true });

  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S04", "S04-PLAN.md"),
    "# S04: Test\n\n## Tasks\n\n- [ ] **T01: Build parser** `est:10m`\n  Build.\n",
    "utf-8",
  );
  // Task plan with must-haves but NO summary file
  writeFileSync(
    join(tasksDir5, "T01-PLAN.md"),
    "# T01: Build parser\n\n## Must-Haves\n\n- [ ] `parseData` function exported\n- [ ] Error handling covers edge cases\n\n## Steps\n\n1. Do stuff\n",
    "utf-8",
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T01 for S04: build parser\n", "utf-8");

  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S04/T01");
  assert.ok(status !== null, "mh-nosummary: status exists");
  assert.deepStrictEqual(status!.mustHaveCount, 2, "mh-nosummary: mustHaveCount is 2");
  assert.deepStrictEqual(status!.mustHavesMentionedInSummary, 0, "mh-nosummary: mustHavesMentionedInSummary is 0 with no summary");
  assert.deepStrictEqual(status!.summaryExists, false, "mh-nosummary: summary doesn't exist");
}

console.log("\n=== must-haves: substring matching (no backtick tokens) ===");
{
  const tasksDir6 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S05", "tasks");
  mkdirSync(tasksDir6, { recursive: true });

  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S05", "S05-PLAN.md"),
    "# S05: Test\n\n## Tasks\n\n- [x] **T01: Add diagnostics** `est:10m`\n  Add.\n",
    "utf-8",
  );
  // Must-haves with no backtick tokens — falls back to substring matching
  writeFileSync(
    join(tasksDir6, "T01-PLAN.md"),
    "# T01: Add diagnostics\n\n## Must-Haves\n\n- [ ] Heuristic matching prioritizes backtick-enclosed code tokens\n- [ ] Recovery diagnostic string shows gap count\n- [ ] All assertions pass\n\n## Steps\n\n1. Do stuff\n",
    "utf-8",
  );
  // Summary mentions "heuristic" and "diagnostic" but not "assertions"
  writeFileSync(
    join(tasksDir6, "T01-SUMMARY.md"),
    "# T01: Add diagnostics\n\nImplemented heuristic matching for must-have items. Recovery diagnostic string now includes gap counts.\n",
    "utf-8",
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S05: next thing\n", "utf-8");

  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S05/T01");
  assert.ok(status !== null, "mh-substr: status exists");
  assert.deepStrictEqual(status!.mustHaveCount, 3, "mh-substr: mustHaveCount is 3");
  // "heuristic" appears in summary for item 1, "diagnostic" for item 2, 
  // "assertions" appears in summary? No — let's check
  // Item 3: "All assertions pass" — words: "assertions", "pass" (<4 chars excluded)
  // summary doesn't contain "assertions" → not matched
  assert.deepStrictEqual(status!.mustHavesMentionedInSummary, 2, "mh-substr: 2 of 3 matched via substring");
  const diag = formatExecuteTaskRecoveryStatus(status!);
  assert.ok(diag.includes("must-have gap"), "mh-substr: diagnostic includes gap info");
  assert.ok(diag.includes("2 of 3"), "mh-substr: diagnostic includes '2 of 3'");
}

rmSync(mhBase, { recursive: true, force: true });
rmSync(base, { recursive: true, force: true });
