// GSD2 — Tests for gsd_milestone_status read-only query tool

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { registerQueryTools } from "../bootstrap/query-tools.ts";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
} from "../gsd-db.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-query-tool-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

function openTestDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
}

async function executeToolInDir(tool: any, params: Record<string, unknown>, dir: string) {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await tool.execute("test-call-id", params, undefined, undefined, undefined);
  } finally {
    process.chdir(originalCwd);
  }
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedMilestone(milestoneId: string, title: string, status = "active"): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run(milestoneId, title, status, new Date().toISOString());
}

function seedSlice(milestoneId: string, sliceId: string, status: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO slices (milestone_id, id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(milestoneId, sliceId, `Slice ${sliceId}`, status, new Date().toISOString());
}

function seedTask(milestoneId: string, sliceId: string, taskId: string, status: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
  ).run(milestoneId, sliceId, taskId, `Task ${taskId}`, status);
}

// ─── Registration ─────────────────────────────────────────────────────────────

test("registerQueryTools registers gsd_milestone_status tool", () => {
  const pi = makeMockPi();
  registerQueryTools(pi);
  assert.equal(pi.tools.length, 1, "Should register exactly one tool");
  assert.equal(pi.tools[0].name, "gsd_milestone_status");
});

test("gsd_milestone_status has promptGuidelines mentioning prohibited alternatives", () => {
  const pi = makeMockPi();
  registerQueryTools(pi);
  const tool = pi.tools[0];
  assert.ok(Array.isArray(tool.promptGuidelines), "promptGuidelines must be an array");
  assert.ok(tool.promptGuidelines.length >= 1, "Must have at least one guideline");
  const joined = tool.promptGuidelines.join(" ");
  assert.match(joined, /sqlite3|better-sqlite3/, "Guidelines must mention prohibited alternatives");
});

// ─── Happy path: milestone with slices and tasks ──────────────────────────────

test("gsd_milestone_status returns milestone metadata and slice statuses", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Test Milestone");
    seedSlice("M001", "S01", "complete");
    seedSlice("M001", "S02", "active");
    seedTask("M001", "S01", "T01", "done");
    seedTask("M001", "S01", "T02", "done");
    seedTask("M001", "S02", "T01", "pending");

    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M001" }, base);
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.milestoneId, "M001");
    assert.equal(parsed.title, "Test Milestone");
    assert.equal(parsed.status, "active");
    assert.equal(parsed.sliceCount, 2);
    assert.equal(parsed.slices.length, 2);

    const s01 = parsed.slices.find((s: any) => s.id === "S01");
    assert.ok(s01, "S01 should be in slices");
    assert.equal(s01.status, "complete");
    assert.equal(s01.taskCounts.total, 2);
    assert.equal(s01.taskCounts.done, 2);

    const s02 = parsed.slices.find((s: any) => s.id === "S02");
    assert.ok(s02, "S02 should be in slices");
    assert.equal(s02.status, "active");
    assert.equal(s02.taskCounts.pending, 1);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── Milestone with no slices ─────────────────────────────────────────────────

test("gsd_milestone_status returns empty slices array for milestone with no slices", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M002", "Empty Milestone");

    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M002" }, base);
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.milestoneId, "M002");
    assert.equal(parsed.sliceCount, 0);
    assert.deepEqual(parsed.slices, []);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── Missing milestone ────────────────────────────────────────────────────────

test("gsd_milestone_status returns not-found for missing milestone", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M999" }, base);
    assert.match(result.content[0].text, /M999.*not found/i);
    assert.equal(result.details.found, false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── DB unavailable ───────────────────────────────────────────────────────────

test("gsd_milestone_status handles missing DB gracefully", async () => {
  // Create a directory without .gsd/ to ensure ensureDbOpen has nothing to open
  const base = join(tmpdir(), `gsd-no-db-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  closeDatabase(); // ensure no prior DB is open
  try {
    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M001" }, base);
    assert.match(result.content[0].text, /GSD database is not available/);
    assert.equal(result.details.error, "db_unavailable");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
