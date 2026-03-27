import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  verifyExpectedArtifact,
  buildLoopRemediationSteps,
} from "../../auto-recovery.ts";
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-idle-recovery-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══ resolveExpectedArtifactPath ═════════════════════════════════════════════

test('resolveExpectedArtifactPath: research-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-milestone", "M001", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("M001-RESEARCH.md"), `path should end with M001-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: plan-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("M001-ROADMAP.md"), `path should end with M001-ROADMAP.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: research-slice', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("S01-RESEARCH.md"), `path should end with S01-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: plan-slice', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("S01-PLAN.md"), `path should end with S01-PLAN.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: complete-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("M001-SUMMARY.md"), `path should end with M001-SUMMARY.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: unknown unit type → null', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("unknown-type", "M001/S01", base);
    assert.deepStrictEqual(result, null, "unknown type returns null");
  } finally {
    cleanup(base);
  }
});

// ═══ writeBlockerPlaceholder ═════════════════════════════════════════════════

test('writeBlockerPlaceholder: writes file for research-slice', () => {
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("research-slice", "M001/S01", base, "idle recovery exhausted 2 attempts");
    assert.ok(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-slice", "M001/S01", base)!;
    assert.ok(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assert.ok(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assert.ok(content.includes("idle recovery exhausted 2 attempts"), "should contain the reason");
    assert.ok(content.includes("research-slice"), "should mention the unit type");
    assert.ok(content.includes("M001/S01"), "should mention the unit ID");
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: creates directory if missing', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-idle-recovery-test-"));
  try {
    // Only create milestone dir, not slice dir
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    // resolveSlicePath needs the slice dir to exist to resolve, so this should return null
    const result = writeBlockerPlaceholder("research-slice", "M001/S01", base, "test reason");
    // Since the slice dir doesn't exist, resolveExpectedArtifactPath returns null
    assert.deepStrictEqual(result, null, "returns null when directory structure doesn't exist");
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: writes file for research-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("research-milestone", "M001", base, "hard timeout");
    assert.ok(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-milestone", "M001", base)!;
    assert.ok(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assert.ok(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assert.ok(content.includes("hard timeout"), "should contain the reason");
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: unknown type → null', () => {
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("unknown-type", "M001/S01", base, "test");
    assert.deepStrictEqual(result, null, "unknown type returns null");
  } finally {
    cleanup(base);
  }
});

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

test('verifyExpectedArtifact: complete-slice — all artifacts present + roadmap marked [x] returns true', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_COMPLETE, "utf-8");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === true, "SUMMARY + UAT + roadmap [x] should verify as true");
  } finally {
    cleanup(base);
  }
});

test('verifyExpectedArtifact: complete-slice — SUMMARY + UAT present but roadmap NOT marked [x] returns false', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_INCOMPLETE, "utf-8");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === false, "roadmap not marked [x] should return false (crash recovery scenario)");
  } finally {
    cleanup(base);
  }
});

test('verifyExpectedArtifact: complete-slice — SUMMARY present but UAT missing returns false', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    // no UAT file
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_COMPLETE, "utf-8");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === false, "missing UAT should return false");
  } finally {
    cleanup(base);
  }
});

test('verifyExpectedArtifact: complete-slice — no roadmap file present is lenient (returns true)', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    // no roadmap file
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === true, "missing roadmap file should be lenient and return true");
  } finally {
    cleanup(base);
  }
});

// ═══ buildLoopRemediationSteps ═══════════════════════════════════════════════

test('buildLoopRemediationSteps: execute-task returns concrete steps', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S03", "tasks"), { recursive: true });
    const result = buildLoopRemediationSteps("execute-task", "M002/S03/T01", base);
    assert.ok(result !== null, "should return remediation steps");
    assert.ok(result!.includes("gsd undo-task"), "steps include undo-task command");
    assert.ok(result!.includes("T01"), "steps mention the task ID");
    assert.ok(result!.includes("gsd undo-task"), "steps include gsd undo-task command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildLoopRemediationSteps: plan-slice returns concrete steps', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const result = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
    assert.ok(result !== null, "should return remediation steps for plan-slice");
    assert.ok(result!.includes("S01-PLAN.md"), "steps mention the slice plan file");
    assert.ok(result!.includes("gsd recover"), "steps include gsd recover command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildLoopRemediationSteps: research-slice returns concrete steps', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const result = buildLoopRemediationSteps("research-slice", "M001/S01", base);
    assert.ok(result !== null, "should return remediation steps for research-slice");
    assert.ok(result!.includes("S01-RESEARCH.md"), "steps mention the slice research file");
    assert.ok(result!.includes("gsd recover"), "steps include gsd recover command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildLoopRemediationSteps: unknown type returns null', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    const result = buildLoopRemediationSteps("unknown-type", "M001/S01", base);
    assert.deepStrictEqual(result, null, "unknown type returns null");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══ verifyExpectedArtifact: hook unit types ═════════════════════════════════

test('verifyExpectedArtifact: hook types always return true', () => {
  const base = createFixtureBase();
  try {
    // Hook units don't have standard artifacts — they should always pass
    const result1 = verifyExpectedArtifact("hook/code-review", "M001/S01/T01", base);
    assert.ok(result1, "hook/code-review should always return true");

    const result2 = verifyExpectedArtifact("hook/simplify", "M001/S01/T02", base);
    assert.ok(result2, "hook/simplify should always return true");

    const result3 = verifyExpectedArtifact("hook/custom-hook", "M001/S01", base);
    assert.ok(result3, "hook/custom-hook at slice level should return true");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


test('writeBlockerPlaceholder: updates DB task status for execute-task (#2531)', async () => {
  const base = createFixtureBase();
  try {
    const { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getTask, isDbAvailable } =
      await import("../../gsd-db.ts");

    const dbPath = join(base, ".gsd", "gsd.db");
    // Create the tasks directory (required for artifact path resolution)
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });

    openDatabase(dbPath);
    try {
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

      // Before fix: writeBlockerPlaceholder wrote the file but left DB as "pending"
      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "idle recovery exhausted");

      const task = getTask("M001", "S01", "T01");
      assert.equal(task?.status, "complete",
        "writeBlockerPlaceholder must update DB task status to 'complete' so verifyExpectedArtifact passes");

      // Verify the full chain works: verifyExpectedArtifact should return true
      const verified = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
      assert.equal(verified, true,
        "verifyExpectedArtifact should pass after writeBlockerPlaceholder updates DB status");
    } finally {
      if (isDbAvailable()) closeDatabase();
    }
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: does NOT update DB for non-execute-task types', async () => {
  const base = createFixtureBase();
  try {
    const { openDatabase, closeDatabase, insertMilestone, insertSlice, getSlice, isDbAvailable } =
      await import("../../gsd-db.ts");

    const dbPath = join(base, ".gsd", "gsd.db");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    openDatabase(dbPath);
    try {
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });

      // research-slice is NOT execute-task — DB should NOT be updated
      writeBlockerPlaceholder("research-slice", "M001/S01", base, "idle recovery exhausted");

      const slice = getSlice("M001", "S01");
      assert.equal(slice?.status, "active",
        "writeBlockerPlaceholder should not change DB status for non-execute-task types");
    } finally {
      if (isDbAvailable()) closeDatabase();
    }
  } finally {
    cleanup(base);
  }
});
