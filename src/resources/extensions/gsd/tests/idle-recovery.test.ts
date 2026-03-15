import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  skipExecuteTask,
  verifyExpectedArtifact,
  buildLoopRemediationSteps,
} from "../auto.ts";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
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
    assertTrue(result !== null, "should resolve a path");
    assertTrue(result!.endsWith("M001-RESEARCH.md"), `path should end with M001-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: plan-milestone ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assertTrue(result !== null, "should resolve a path");
    assertTrue(result!.endsWith("M001-ROADMAP.md"), `path should end with M001-ROADMAP.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: research-slice ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assertTrue(result !== null, "should resolve a path");
    assertTrue(result!.endsWith("S01-RESEARCH.md"), `path should end with S01-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: plan-slice ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assertTrue(result !== null, "should resolve a path");
    assertTrue(result!.endsWith("S01-PLAN.md"), `path should end with S01-PLAN.md, got ${result}`);
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== resolveExpectedArtifactPath: complete-milestone ===");
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assertTrue(result !== null, "should resolve a path");
    assertTrue(result!.endsWith("M001-SUMMARY.md"), `path should end with M001-SUMMARY.md, got ${result}`);
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
    assertTrue(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-slice", "M001/S01", base)!;
    assertTrue(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assertTrue(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assertTrue(content.includes("idle recovery exhausted 2 attempts"), "should contain the reason");
    assertTrue(content.includes("research-slice"), "should mention the unit type");
    assertTrue(content.includes("M001/S01"), "should mention the unit ID");
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
    assertTrue(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-milestone", "M001", base)!;
    assertTrue(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assertTrue(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assertTrue(content.includes("hard timeout"), "should contain the reason");
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

    assertTrue(result === true, "should return true");

    // Check summary was written
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    assertTrue(existsSync(summaryPath), "task summary should exist");
    const summaryContent = readFileSync(summaryPath, "utf-8");
    assertTrue(summaryContent.includes("BLOCKER"), "summary should contain BLOCKER");
    assertTrue(summaryContent.includes("T01"), "summary should mention task ID");

    // Check plan checkbox was marked
    const planContent = readFileSync(planPath, "utf-8");
    assertTrue(planContent.includes("- [x] **T01:"), "T01 should be checked");
    assertTrue(planContent.includes("- [ ] **T02:"), "T02 should remain unchecked");
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

    assertTrue(result === true, "should return true");

    // Summary should be untouched (not overwritten with blocker)
    const content = readFileSync(summaryPath, "utf-8");
    assertTrue(content.includes("Real summary"), "original summary should be preserved");
    assertTrue(!content.includes("BLOCKER"), "should not contain BLOCKER");

    // Plan checkbox should still be marked
    const planContent = readFileSync(planPath, "utf-8");
    assertTrue(planContent.includes("- [x] **T01:"), "T01 should be checked");
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

    assertTrue(result === true, "should return true");

    // Summary should be written (since summaryExists was false)
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    assertTrue(existsSync(summaryPath), "task summary should exist");

    // Plan checkbox should be untouched
    const planContent = readFileSync(planPath, "utf-8");
    assertTrue(planContent.includes("- [x] **T01:"), "T01 should remain checked");
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

    assertTrue(result === true, "should return true");

    const planContent = readFileSync(planPath, "utf-8");
    assertTrue(planContent.includes("- [x] **T01.1:"), "T01.1 should be checked (regex chars escaped)");
  } finally {
    cleanup(base);
  }
}

// ═══ verifyExpectedArtifact: complete-slice roadmap check ════════════════════
// Regression for #indefinite-hang: complete-slice must verify roadmap [x] or
// the idempotency skip loops forever after a crash that wrote SUMMARY+UAT but
// did not mark the roadmap done.

const ROADMAP_INCOMPLETE = `# M001: Test Milestone

## Slices

- [ ] **S01: Test Slice** \`risk:low\`
> After this: something works
`;

const ROADMAP_COMPLETE = `# M001: Test Milestone

## Slices

- [x] **S01: Test Slice** \`risk:low\`
> After this: something works
`;

{
  console.log("\n=== verifyExpectedArtifact: complete-slice — all artifacts present + roadmap marked [x] returns true ===");
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_COMPLETE, "utf-8");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assertTrue(result === true, "SUMMARY + UAT + roadmap [x] should verify as true");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== verifyExpectedArtifact: complete-slice — SUMMARY + UAT present but roadmap NOT marked [x] returns false ===");
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_INCOMPLETE, "utf-8");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assertTrue(result === false, "roadmap not marked [x] should return false (crash recovery scenario)");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== verifyExpectedArtifact: complete-slice — SUMMARY present but UAT missing returns false ===");
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    // no UAT file
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_COMPLETE, "utf-8");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assertTrue(result === false, "missing UAT should return false");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== verifyExpectedArtifact: complete-slice — no roadmap file present is lenient (returns true) ===");
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    // no roadmap file
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assertTrue(result === true, "missing roadmap file should be lenient and return true");
  } finally {
    cleanup(base);
  }
}

// ═══ buildLoopRemediationSteps ═══════════════════════════════════════════════

{
  console.log("\n=== buildLoopRemediationSteps: execute-task returns concrete steps ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S03", "tasks"), { recursive: true });
    const result = buildLoopRemediationSteps("execute-task", "M002/S03/T01", base);
    assertTrue(result !== null, "should return remediation steps");
    assertTrue(result!.includes("T01-SUMMARY.md"), "steps mention the summary file");
    assertTrue(result!.includes("S03-PLAN.md"), "steps mention the slice plan");
    assertTrue(result!.includes("T01"), "steps mention the task ID");
    assertTrue(result!.includes("gsd doctor"), "steps include gsd doctor command");
    // Exact slice plan checkbox syntax (no trailing **)
    assertTrue(result!.includes('"- [x] **T01:"'), "steps show exact checkbox syntax without trailing **");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

{
  console.log("\n=== buildLoopRemediationSteps: plan-slice returns concrete steps ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const result = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
    assertTrue(result !== null, "should return remediation steps for plan-slice");
    assertTrue(result!.includes("S01-PLAN.md"), "steps mention the slice plan file");
    assertTrue(result!.includes("gsd doctor"), "steps include gsd doctor command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

{
  console.log("\n=== buildLoopRemediationSteps: research-slice returns concrete steps ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const result = buildLoopRemediationSteps("research-slice", "M001/S01", base);
    assertTrue(result !== null, "should return remediation steps for research-slice");
    assertTrue(result!.includes("S01-RESEARCH.md"), "steps mention the slice research file");
    assertTrue(result!.includes("gsd doctor"), "steps include gsd doctor command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

{
  console.log("\n=== buildLoopRemediationSteps: unknown type returns null ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    const result = buildLoopRemediationSteps("unknown-type", "M001/S01", base);
    assertEq(result, null, "unknown type returns null");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

{
  console.log("\n=== skipExecuteTask: loop-recovery writes blocker when both summary and checkbox missing ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-recovery-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S03", "tasks"), { recursive: true });
    const planPath = join(base, ".gsd", "milestones", "M002", "slices", "S03", "S03-PLAN.md");
    writeFileSync(planPath, [
      "# S03: Harden guided session",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Harden contract usage** `est:30m`",
      "  Harden guided session contract usage in desktop flow.",
    ].join("\n"), "utf-8");

    const result = skipExecuteTask(
      base, "M002", "S03", "T01",
      { summaryExists: false, taskChecked: false },
      "loop-recovery",
      // 3 == MAX_UNIT_DISPATCHES: represents the prevCount when the final
      // reconciliation path runs (loop detected, reconciling before halting).
      3,
    );

    assertTrue(result === true, "loop-recovery should succeed");

    // Blocker summary written
    const summaryPath = join(base, ".gsd", "milestones", "M002", "slices", "S03", "tasks", "T01-SUMMARY.md");
    assertTrue(existsSync(summaryPath), "blocker summary should be written");
    const summaryContent = readFileSync(summaryPath, "utf-8");
    assertTrue(summaryContent.includes("BLOCKER"), "summary should be a blocker placeholder");
    assertTrue(summaryContent.includes("loop-recovery"), "summary should mention the recovery reason");

    // Checkbox marked
    const planContent = readFileSync(planPath, "utf-8");
    assertTrue(planContent.includes("- [x] **T01:"), "T01 checkbox should be marked [x] after loop-recovery");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ═══ verifyExpectedArtifact: hook unit types ═════════════════════════════════

console.log("\n=== verifyExpectedArtifact: hook types always return true ===");

{
  const base = createFixtureBase();
  try {
    // Hook units don't have standard artifacts — they should always pass
    const result1 = verifyExpectedArtifact("hook/code-review", "M001/S01/T01", base);
    assertTrue(result1, "hook/code-review should always return true");

    const result2 = verifyExpectedArtifact("hook/simplify", "M001/S01/T02", base);
    assertTrue(result2, "hook/simplify should always return true");

    const result3 = verifyExpectedArtifact("hook/custom-hook", "M001/S01", base);
    assertTrue(result3, "hook/custom-hook at slice level should return true");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

report();
