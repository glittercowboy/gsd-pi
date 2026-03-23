import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  resolveExpectedArtifactPath,
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

// writeBlockerPlaceholder and skipExecuteTask tests removed (D-05)
// These functions are replaced by engine.reportBlocker()

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

// skipExecuteTask loop-recovery test removed (D-05) — replaced by engine.reportBlocker()

report();
