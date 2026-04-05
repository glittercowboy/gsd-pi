/**
 * Tests for read-only MCP project state readers (#3515).
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readProgress } from "./progress.js";
import { readRoadmap } from "./roadmap.js";
import { readHistory } from "./history.js";
import { readDoctor } from "./doctor.js";
import { readCaptures } from "./captures.js";
import { readKnowledge } from "./knowledge.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "gsd-mcp-reader-"));
}

function scaffold(tmp: string): void {
  const gsd = join(tmp, ".gsd");
  mkdirSync(gsd, { recursive: true });
  mkdirSync(join(gsd, "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });

  writeFileSync(join(gsd, "STATE.md"), [
    "## Status",
    "active_milestone: M001",
    "phase: executing",
    "active_slice: S01",
    "active_task: T01",
  ].join("\n"));

  writeFileSync(join(gsd, "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001 — Foundation",
    "",
    "## Slices",
    "- [x] **S01: Setup** `risk:low` `depends:[]`",
    "- [ ] **S02: Core** `risk:medium` `depends:[S01]`",
  ].join("\n"));

  writeFileSync(join(gsd, "milestones", "M001", "slices", "S01", "S01-PLAN.md"), [
    "# S01 Plan",
    "",
    "## Tasks",
    "- [x] **T01: Init project** `est:15min`",
    "- [ ] **T02: Add tests** `est:30min`",
  ].join("\n"));

  writeFileSync(join(gsd, "REQUIREMENTS.md"), "# Requirements\n\n## Active\n");
  writeFileSync(join(gsd, "DECISIONS.md"), "# Decisions Register\n");
  writeFileSync(join(gsd, "KNOWLEDGE.md"), [
    "# Knowledge",
    "",
    "## Patterns",
    "- Always run tests before committing",
    "- Use conventional commits",
    "",
    "## Lessons",
    "- DB must be opened before deriveState",
  ].join("\n"));

  writeFileSync(join(gsd, "CAPTURES.md"), [
    "# Captures",
    "- [ ] (c1) Add CI pipeline",
    "- [x] (c2) Fix README typo",
    "- [ ] (c3) Consider caching layer",
  ].join("\n"));

  writeFileSync(join(gsd, "metrics.json"), JSON.stringify({
    units: [
      { id: "M001/S01/T01", type: "execute-task", model: "sonnet", startedAt: 1000000, finishedAt: 1060000, tokens: { input: 500, output: 200, total: 700 }, cost: 0.02, toolCalls: 5 },
      { id: "M001/S01/T02", type: "execute-task", model: "opus", startedAt: 1100000, finishedAt: 1200000, tokens: { input: 1000, output: 500, total: 1500 }, cost: 0.08, toolCalls: 12 },
    ],
  }));

  // Create gsd.db as empty file (just to pass the exists check)
  writeFileSync(join(gsd, "gsd.db"), "");
}

describe("MCP readers (#3515)", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); scaffold(tmp); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  // ── gsd_progress ────────────────────────────────────────────────────────

  test("readProgress returns active milestone and slice counts", async () => {
    const result = await readProgress(tmp);
    assert.equal(result.activeMilestone, "M001");
    assert.equal(result.phase, "executing");
    assert.equal(result.activeSlice, "S01");
    assert.equal(result.slices.total, 2);
    assert.equal(result.slices.complete, 1);
  });

  test("readProgress returns sensible nextAction", async () => {
    const result = await readProgress(tmp);
    assert.ok(result.nextAction.includes("T01") || result.nextAction.includes("S01"));
  });

  // ── gsd_roadmap ─────────────────────────────────────────────────────────

  test("readRoadmap returns milestone and slice structure", async () => {
    const result = await readRoadmap(tmp);
    assert.equal(result.milestones.length, 1);
    assert.equal(result.milestones[0].id, "M001");
    assert.equal(result.milestones[0].slices.length, 2);
    assert.equal(result.milestones[0].slices[0].done, true);
    assert.equal(result.milestones[0].slices[1].done, false);
    assert.deepEqual(result.milestones[0].slices[1].depends, ["S01"]);
  });

  test("readRoadmap parses tasks within slices", async () => {
    const result = await readRoadmap(tmp);
    const tasks = result.milestones[0].slices[0].tasks;
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, "T01");
    assert.equal(tasks[0].done, true);
    assert.equal(tasks[1].estimate, "30min");
  });

  // ── gsd_history ─────────────────────────────────────────────────────────

  test("readHistory returns execution metrics", async () => {
    const result = await readHistory(tmp);
    assert.equal(result.totalUnits, 2);
    assert.equal(result.totalCost, 0.1);
    assert.equal(result.totalTokens, 2200);
    assert.equal(result.entries.length, 2);
  });

  // ── gsd_doctor ──────────────────────────────────────────────────────────

  test("readDoctor returns healthy for well-formed project", async () => {
    const result = await readDoctor(tmp);
    assert.equal(result.healthy, true);
    assert.ok(result.checks.some(c => c.name === "gsd-dir" && c.status === "pass"));
    assert.ok(result.checks.some(c => c.name === "database" && c.status === "pass"));
  });

  test("readDoctor returns fail when .gsd/ missing", async () => {
    const empty = makeTmp();
    const result = await readDoctor(empty);
    assert.equal(result.healthy, false);
    rmSync(empty, { recursive: true, force: true });
  });

  // ── gsd_captures ────────────────────────────────────────────────────────

  test("readCaptures returns all captures", async () => {
    const result = await readCaptures(tmp);
    assert.equal(result.total, 3);
    assert.equal(result.pending, 2);
    assert.equal(result.entries.length, 3);
  });

  test("readCaptures filters pending only", async () => {
    const result = await readCaptures(tmp, "pending");
    assert.equal(result.entries.length, 2);
    assert.ok(result.entries.every(e => e.status === "pending"));
  });

  // ── gsd_knowledge ───────────────────────────────────────────────────────

  test("readKnowledge parses sections and entries", async () => {
    const result = await readKnowledge(tmp);
    assert.equal(result.entries.length, 3);
    assert.ok(result.entries.some(e => e.section === "Patterns" && e.text.includes("conventional commits")));
    assert.ok(result.entries.some(e => e.section === "Lessons" && e.text.includes("deriveState")));
    assert.ok(result.raw !== null);
  });
});
