import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  skipExecuteTask,
} from "../auto.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-idle-recovery-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══ resolveExpectedArtifactPath ═════════════════════════════════════════════

{
  console.log("\n=== resolveExpectedArtifactPath: research-milestone ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-milestone", "M001", base);
    assert(result !== null, "should resolve a path");
    assert(result!.endsWith("M001-RESEARCH.md"), `path should end with M001-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: plan-milestone ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assert(result !== null, "should resolve a path");
    assert(result!.endsWith("M001-ROADMAP.md"), `path should end with M001-ROADMAP.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: research-slice ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assert(result !== null, "should resolve a path");
    assert(result!.endsWith("S01-RESEARCH.md"), `path should end with S01-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: plan-slice ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assert(result !== null, "should resolve a path");
    assert(result!.endsWith("S01-PLAN.md"), `path should end with S01-PLAN.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: complete-milestone ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert(result !== null, "should resolve a path");
    assert(result!.endsWith("M001-SUMMARY.md"), `path should end with M001-SUMMARY.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: unknown unit type → null ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("unknown-type", "M001/S01", base);
    assertEq(result, null, "unknown type returns null");
  } finally {
    cleanup(base);
  }
}

// ═══ writeBlockerPlaceholder ═════════════════════════════════════════════════

{
  console.log("\n=== writeBlockerPlaceholder: writes file for research-slice ===");
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("research-slice", "M001/S01", base, "idle recovery exhausted 2 attempts");
    assert(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-slice", "M001/S01", base)!;
    assert(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assert(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assert(content.includes("idle recovery exhausted 2 attempts"), "should contain the reason");
    assert(content.includes("research-slice"), "should mention the unit type");
    assert(content.includes("M001/S01"), "should mention the unit ID");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== writeBlockerPlaceholder: creates directory if missing ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-idle-recovery-test-"));
  try {
    // Only create milestone dir, not slice dir
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    // resolveSlicePath needs the slice dir to exist to resolve, so this should return null
    const result = writeBlockerPlaceholder("research-slice", "M001/S01", base, "test reason");
    // Since the slice dir doesn't exist, resolveExpectedArtifactPath returns null
    assertEq(result, null, "returns null when directory structure doesn't exist");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== writeBlockerPlaceholder: writes file for research-milestone ===");
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("research-milestone", "M001", base, "hard timeout");
    assert(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-milestone", "M001", base)!;
    assert(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assert(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assert(content.includes("hard timeout"), "should contain the reason");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== writeBlockerPlaceholder: unknown type → null ===");
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("unknown-type", "M001/S01", base, "test");
    assertEq(result, null, "unknown type returns null");
  } finally {
    cleanup(base);
  }
}

// ═══ skipExecuteTask ═════════════════════════════════════════════════════════

{
  console.log("\n=== skipExecuteTask: writes summary and checks plan checkbox ===");
  const base = createFixtureBase();
  try {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    writeFileSync(planPath, [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First task** `est:10m`",
      "  Do the first thing.",
      "- [ ] **T02: Second task** `est:15m`",
      "  Do the second thing.",
    ].join("\n"), "utf-8");

    const result = skipExecuteTask(
      base, "M001", "S01", "T01",
      { summaryExists: false, taskChecked: false },
      "idle", 2,
    );

    assert(result === true, "should return true");

    // Check summary was written
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    assert(existsSync(summaryPath), "task summary should exist");
    const summaryContent = readFileSync(summaryPath, "utf-8");
    assert(summaryContent.includes("BLOCKER"), "summary should contain BLOCKER");
    assert(summaryContent.includes("T01"), "summary should mention task ID");

    // Check plan checkbox was marked
    const planContent = readFileSync(planPath, "utf-8");
    assert(planContent.includes("- [x] **T01:"), "T01 should be checked");
    assert(planContent.includes("- [ ] **T02:"), "T02 should remain unchecked");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== skipExecuteTask: skips summary if already exists ===");
  const base = createFixtureBase();
  try {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    writeFileSync(planPath, "- [ ] **T01: Task** `est:10m`\n", "utf-8");

    // Pre-write a summary
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    writeFileSync(summaryPath, "# Real summary\nActual work done.", "utf-8");

    const result = skipExecuteTask(
      base, "M001", "S01", "T01",
      { summaryExists: true, taskChecked: false },
      "idle", 2,
    );

    assert(result === true, "should return true");

    // Summary should be untouched (not overwritten with blocker)
    const content = readFileSync(summaryPath, "utf-8");
    assert(content.includes("Real summary"), "original summary should be preserved");
    assert(!content.includes("BLOCKER"), "should not contain BLOCKER");

    // Plan checkbox should still be marked
    const planContent = readFileSync(planPath, "utf-8");
    assert(planContent.includes("- [x] **T01:"), "T01 should be checked");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== skipExecuteTask: skips checkbox if already checked ===");
  const base = createFixtureBase();
  try {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    writeFileSync(planPath, "- [x] **T01: Task** `est:10m`\n", "utf-8");

    const result = skipExecuteTask(
      base, "M001", "S01", "T01",
      { summaryExists: false, taskChecked: true },
      "idle", 2,
    );

    assert(result === true, "should return true");

    // Summary should be written (since summaryExists was false)
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    assert(existsSync(summaryPath), "task summary should exist");

    // Plan checkbox should be untouched
    const planContent = readFileSync(planPath, "utf-8");
    assert(planContent.includes("- [x] **T01:"), "T01 should remain checked");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== skipExecuteTask: handles special regex chars in task ID ===");
  const base = createFixtureBase();
  try {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    writeFileSync(planPath, "- [ ] **T01.1: Sub-task** `est:10m`\n", "utf-8");

    const result = skipExecuteTask(
      base, "M001", "S01", "T01.1",
      { summaryExists: false, taskChecked: false },
      "idle", 2,
    );

    assert(result === true, "should return true");

    const planContent = readFileSync(planPath, "utf-8");
    assert(planContent.includes("- [x] **T01.1:"), "T01.1 should be checked (regex chars escaped)");
  } finally {
    cleanup(base);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Results
// ═════════════════════════════════════════════════════════════════════════════

console.log(`\n${"=".repeat(40)}`);
if (failed > 0) {
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
} else {
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("All tests passed ✓");
}
