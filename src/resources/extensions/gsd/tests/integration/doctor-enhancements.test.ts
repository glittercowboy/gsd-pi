import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGSDDoctor } from "../../doctor.js";
import { formatDoctorReportJson } from "../../doctor-format.js";
// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBase(): { base: string; gsd: string; mDir: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-enh-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  mkdirSync(join(mDir, "slices"), { recursive: true });
  return { base, gsd, mDir };
}

function writeRoadmap(mDir: string, content: string): void {
  writeFileSync(join(mDir, "M001-ROADMAP.md"), content);
}

function writeSlice(mDir: string, sliceId: string, planContent: string): string {
  const sDir = join(mDir, "slices", sliceId);
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(sDir, `${sliceId}-PLAN.md`), planContent);
  return sDir;
}

describe('doctor-enhancements', async () => {
  // ── 1. Circular dependency detection ──────────────────────────────────────
  test('circular dependency detection', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Circular Test\n\n## Slices\n- [ ] **S01: Slice A** \`risk:low\` \`depends:[S02]\`\n  > After this: done\n- [ ] **S02: Slice B** \`risk:low\` \`depends:[S01]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice A\n\n**Goal:** A\n**Demo:** A\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");
    writeSlice(mDir, "S02", "# S02: Slice B\n\n**Goal:** B\n**Demo:** B\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "circular_slice_dependency"),
      "detects circular dependency S01 → S02 → S01",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 2. Duplicate task IDs ──────────────────────────────────────────────────
  test('duplicate task IDs', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Dup Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: First** `est:10m`\n  Task one.\n- [ ] **T01: Duplicate** `est:10m`\n  Task dup.\n");

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "duplicate_task_id"),
      "detects duplicate task ID T01",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 3. Orphaned slice directory ──────────────────────────────────────────
  test('orphaned slice directory', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Orphan Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");
    // Create an extra slice directory not in roadmap
    mkdirSync(join(mDir, "slices", "S99"), { recursive: true });

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "orphaned_slice_directory" && i.message.includes("S99")),
      "detects orphaned slice directory S99",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 4. Task file not in plan ───────────────────────────────────────────────
  test('task file not in plan', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Extra Task Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    const sDir = writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [x] **T01: Task** `est:10m`\n  Done.\n");
    // T01 summary (matches plan)
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), "---\nstatus: done\n---\n# T01\nDone.\n");
    // T99 summary (NOT in plan)
    writeFileSync(join(sDir, "tasks", "T99-SUMMARY.md"), "---\nstatus: done\n---\n# T99\nExtra.\n");

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "task_file_not_in_plan" && i.message.includes("T99")),
      "detects task summary T99 not in plan",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 5. Stale REPLAN file ────────────────────────────────────────────────────
  test('stale REPLAN detection', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Replan Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    const sDir = writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [x] **T01: Task** `est:10m`\n  Done.\n");
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), "---\nstatus: done\ncompleted_at: 2026-01-01T00:00:00Z\n---\n# T01\nDone.\n");
    // Add a REPLAN file even though all tasks are done
    writeFileSync(join(sDir, "S01-REPLAN.md"), "# S01 REPLAN\nSomething changed.\n");

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "stale_replan_file"),
      "detects stale REPLAN when all tasks are done",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 6. Metrics ledger corrupt ───────────────────────────────────────────────
  test('metrics ledger corrupt', async () => {
    const { base, gsd, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Metrics Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");
    // Write invalid metrics.json
    writeFileSync(join(gsd, "metrics.json"), '{"version":2,"data":[]}');

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "metrics_ledger_corrupt"),
      "detects corrupt metrics ledger (version != 1)",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 7. Large planning file ──────────────────────────────────────────────────
  test('large planning file', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Large File Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    const sDir = writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");
    // Write a 101KB .md file
    const bigContent = "# Big File\n" + "x".repeat(101 * 1024);
    writeFileSync(join(sDir, "BIGFILE.md"), bigContent);

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "large_planning_file"),
      "detects large planning file over 100KB",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 8. Future timestamp ─────────────────────────────────────────────────────
  test('future timestamp', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Timestamp Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    const sDir = writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [x] **T01: Task** `est:10m`\n  Done.\n");
    // completed_at is 2 days in the future
    const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(sDir, "tasks", "T01-SUMMARY.md"),
      `---\nstatus: done\ncompleted_at: ${futureDate}\n---\n# T01\nDone.\n`,
    );

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(
      result.issues.some(i => i.code === "future_timestamp"),
      "detects future completed_at timestamp",
    );
    rmSync(base, { recursive: true, force: true });
  });

  // ── 9. JSON output format ───────────────────────────────────────────────────
  test('JSON output format', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: JSON Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");

    const result = await runGSDDoctor(base, { fix: false });
    const json = formatDoctorReportJson(result);

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }

    assert.ok(parsed !== null, "formatDoctorReportJson produces valid JSON");
    assert.ok(typeof (parsed as Record<string, unknown>)?.ok === "boolean", "JSON has ok field");
    assert.ok(Array.isArray((parsed as Record<string, unknown>)?.issues), "JSON has issues array");
    assert.ok(Array.isArray((parsed as Record<string, unknown>)?.fixesApplied), "JSON has fixesApplied array");
    assert.ok(typeof (parsed as Record<string, unknown>)?.generatedAt === "string", "JSON has generatedAt field");
    assert.ok(typeof (parsed as Record<string, unknown>)?.summary === "object", "JSON has summary object");

    rmSync(base, { recursive: true, force: true });
  });

  // ── 10. Dry-run mode ────────────────────────────────────────────────────────
  test('dry-run mode', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Dry Run Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");

    const result = await runGSDDoctor(base, { fix: true, dryRun: true });
    // dry-run with fix:true still runs the doctor; shouldFix() returns false
    // so no reconciliation fixes are applied through that path
    assert.ok(result.issues !== undefined, "dry-run still produces issue list");
    assert.ok(Array.isArray(result.fixesApplied), "dry-run report has fixesApplied array");

    rmSync(base, { recursive: true, force: true });
  });

  // ── 11. Per-check timing ─────────────────────────────────────────────────────
  test('per-check timing', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Timing Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");

    const result = await runGSDDoctor(base, { fix: false });
    assert.ok(result.timing !== undefined, "report includes timing");
    assert.ok(typeof result.timing?.git === "number", "timing.git is a number");
    assert.ok(typeof result.timing?.runtime === "number", "timing.runtime is a number");
    assert.ok(typeof result.timing?.environment === "number", "timing.environment is a number");
    assert.ok(typeof result.timing?.gsdState === "number", "timing.gsdState is a number");

    rmSync(base, { recursive: true, force: true });
  });

  // ── 12. Doctor history ───────────────────────────────────────────────────────
  test('doctor history', async () => {
    const { base, gsd, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: History Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(mDir, "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");

    await runGSDDoctor(base, { fix: false });

    const historyPath = join(gsd, "doctor-history.jsonl");
    assert.ok(existsSync(historyPath), "doctor-history.jsonl is created after run");

    const { readDoctorHistory } = await import("../../doctor.js");
    const history = await readDoctorHistory(base);
    assert.ok(history.length >= 1, "history has at least one entry");
    assert.ok(typeof history[0]?.ts === "string", "history entry has ts field");
    assert.ok(typeof history[0]?.ok === "boolean", "history entry has ok field");
    assert.ok(typeof history[0]?.errors === "number", "history entry has errors count");
    assert.ok(Array.isArray(history[0]?.codes), "history entry has codes array");

    rmSync(base, { recursive: true, force: true });
  });
});
