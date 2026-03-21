/**
 * Unit tests for context manifest pure functions.
 * Tests buildContextManifest(), buildTargetedPreloads(), inventoryContextFiles(),
 * and formatFileSize() — all pure or near-pure (statSync for inventory).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type ContextManifestEntry,
  buildContextManifest,
  buildTargetedPreloads,
  inventoryContextFiles,
  formatFileSize,
} from "../auto-prompts.js";

// ─── formatFileSize ──────────────────────────────────────────────────────────

describe("context-manifest: formatFileSize", () => {
  it("formats zero bytes", () => {
    assert.equal(formatFileSize(0), "0 B");
  });

  it("formats small byte values (<1024)", () => {
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(1), "1 B");
    assert.equal(formatFileSize(1023), "1023 B");
  });

  it("formats exactly 1024 bytes as KB", () => {
    assert.equal(formatFileSize(1024), "1.0 KB");
  });

  it("formats larger values as KB with one decimal", () => {
    assert.equal(formatFileSize(2048), "2.0 KB");
    assert.equal(formatFileSize(2560), "2.5 KB");
    assert.equal(formatFileSize(15360), "15.0 KB");
  });

  it("formats fractional KB correctly", () => {
    // 1536 / 1024 = 1.5
    assert.equal(formatFileSize(1536), "1.5 KB");
    // 3072 / 1024 = 3.0
    assert.equal(formatFileSize(3072), "3.0 KB");
  });
});

// ─── buildContextManifest ────────────────────────────────────────────────────

describe("context-manifest: buildContextManifest", () => {
  it("produces a valid markdown table with correct columns", () => {
    const entries: ContextManifestEntry[] = [
      { relPath: "path/to/plan.md", purpose: "Slice plan", sizeBytes: 2355 },
      { relPath: "path/to/summary.md", purpose: "Dependency summary", sizeBytes: 512 },
    ];
    const result = buildContextManifest(entries);

    assert.ok(result.startsWith("## Context Manifest"), "should start with heading");
    assert.ok(result.includes("| File | Purpose | Size |"), "should have header row");
    assert.ok(result.includes("|------|---------|------|"), "should have separator row");
    assert.ok(result.includes("| `path/to/plan.md` | Slice plan | 2.3 KB |"), "should format KB sizes");
    assert.ok(result.includes("| `path/to/summary.md` | Dependency summary | 512 B |"), "should format byte sizes");
  });

  it("shows (not yet created) for entries with null size", () => {
    const entries: ContextManifestEntry[] = [
      { relPath: "path/to/future.md", purpose: "Future file", sizeBytes: null },
    ];
    const result = buildContextManifest(entries);
    assert.ok(result.includes("(not yet created)"), "null size should show as (not yet created)");
  });

  it("produces table with headers only for empty entries array", () => {
    const result = buildContextManifest([]);
    const lines = result.split("\n");
    assert.equal(lines.length, 3, "should have heading + header + separator only");
    assert.ok(lines[0].startsWith("## Context Manifest"));
    assert.ok(lines[1].includes("| File | Purpose | Size |"));
    assert.ok(lines[2].includes("|------|---------|------|"));
  });

  it("handles mixed existing and missing files", () => {
    const entries: ContextManifestEntry[] = [
      { relPath: "a.md", purpose: "File A", sizeBytes: 100 },
      { relPath: "b.md", purpose: "File B", sizeBytes: null },
      { relPath: "c.md", purpose: "File C", sizeBytes: 4096 },
    ];
    const result = buildContextManifest(entries);
    const lines = result.split("\n");
    // 3 header lines + 3 data rows = 6
    assert.equal(lines.length, 6);
    assert.ok(lines[3].includes("100 B"));
    assert.ok(lines[4].includes("(not yet created)"));
    assert.ok(lines[5].includes("4.0 KB"));
  });

  it("formats size thresholds correctly", () => {
    const entries: ContextManifestEntry[] = [
      { relPath: "small.md", purpose: "Small", sizeBytes: 100 },
      { relPath: "boundary.md", purpose: "Boundary", sizeBytes: 1024 },
      { relPath: "large.md", purpose: "Large", sizeBytes: 10240 },
    ];
    const result = buildContextManifest(entries);
    assert.ok(result.includes("100 B"));
    assert.ok(result.includes("1.0 KB"));
    assert.ok(result.includes("10.0 KB"));
  });
});

// ─── buildTargetedPreloads ───────────────────────────────────────────────────

describe("context-manifest: buildTargetedPreloads", () => {
  it("concatenates all three sections with separators", () => {
    const result = buildTargetedPreloads({
      taskPlanInline: "# Task Plan\nDo the thing",
      slicePlanExcerpt: "## Slice\nGoal: stuff",
      dependencySummaries: "## Deps\nT01 did things",
    });

    assert.ok(result.includes("# Task Plan\nDo the thing"));
    assert.ok(result.includes("---"));
    assert.ok(result.includes("## Slice\nGoal: stuff"));
    assert.ok(result.includes("## Deps\nT01 did things"));
  });

  it("omits empty sections", () => {
    const result = buildTargetedPreloads({
      taskPlanInline: "# Task Plan\nContent here",
      slicePlanExcerpt: "",
      dependencySummaries: "## Deps\nSome deps",
    });

    assert.ok(result.includes("# Task Plan"));
    assert.ok(result.includes("## Deps"));
    // Should not contain consecutive separators from empty section
    assert.ok(!result.includes("---\n\n---"));
  });

  it("omits whitespace-only sections", () => {
    const result = buildTargetedPreloads({
      taskPlanInline: "# Plan",
      slicePlanExcerpt: "   \n  \n  ",
      dependencySummaries: "",
    });

    assert.equal(result, "# Plan");
  });

  it("returns empty string when all sections are empty", () => {
    const result = buildTargetedPreloads({
      taskPlanInline: "",
      slicePlanExcerpt: "",
      dependencySummaries: "",
    });

    assert.equal(result, "");
  });

  it("preserves full content without truncation", () => {
    const longContent = "x".repeat(50000);
    const result = buildTargetedPreloads({
      taskPlanInline: longContent,
      slicePlanExcerpt: "short",
      dependencySummaries: "also short",
    });

    // The long content should be fully present — no truncation
    assert.ok(result.includes(longContent));
    assert.ok(!result.includes("[...truncated"));
  });
});

// ─── inventoryContextFiles ───────────────────────────────────────────────────

describe("context-manifest: inventoryContextFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-manifest-test-"));

    // Create a minimal .gsd directory structure
    const gsdDir = join(tmpDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });

    // Create milestone directory
    const milestoneDir = join(gsdDir, "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });

    // Create slice directory with tasks
    const sliceDir = join(milestoneDir, "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    // Write some files with known content
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\nDo stuff");
    writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01 Plan\nSlice goal");
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# Roadmap\n- S01");
    writeFileSync(join(gsdDir, "DECISIONS.md"), "# Decisions");
    writeFileSync(join(gsdDir, "KNOWLEDGE.md"), "# Knowledge base");
    writeFileSync(join(gsdDir, "REQUIREMENTS.md"), "# Requirements");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct entries for a fixture directory with real files", () => {
    const entries = inventoryContextFiles(tmpDir, "M001", "S01", "T01", []);

    // Should have 6 base entries: task plan, slice plan, roadmap, decisions, knowledge, requirements
    assert.equal(entries.length, 6);

    // Task plan entry
    const taskPlan = entries.find(e => e.relPath.includes("T01-PLAN.md"));
    assert.ok(taskPlan, "should have task plan entry");
    assert.ok(taskPlan.purpose.includes("Task plan"));
    assert.ok(typeof taskPlan.sizeBytes === "number" && taskPlan.sizeBytes > 0, "task plan should have size");

    // Slice plan entry
    const slicePlan = entries.find(e => e.relPath.includes("S01-PLAN.md"));
    assert.ok(slicePlan, "should have slice plan entry");
    assert.ok(typeof slicePlan.sizeBytes === "number" && slicePlan.sizeBytes > 0);

    // Roadmap entry
    const roadmap = entries.find(e => e.relPath.includes("ROADMAP"));
    assert.ok(roadmap, "should have roadmap entry");
    assert.ok(typeof roadmap.sizeBytes === "number" && roadmap.sizeBytes > 0);

    // Decisions entry
    const decisions = entries.find(e => e.relPath.includes("DECISIONS"));
    assert.ok(decisions, "should have decisions entry");
    assert.ok(typeof decisions.sizeBytes === "number" && decisions.sizeBytes > 0);

    // Knowledge entry
    const knowledge = entries.find(e => e.relPath.includes("KNOWLEDGE"));
    assert.ok(knowledge, "should have knowledge entry");
    assert.ok(typeof knowledge.sizeBytes === "number" && knowledge.sizeBytes > 0);

    // Requirements entry
    const reqs = entries.find(e => e.relPath.includes("REQUIREMENTS"));
    assert.ok(reqs, "should have requirements entry");
    assert.ok(typeof reqs.sizeBytes === "number" && reqs.sizeBytes > 0);
  });

  it("handles missing files by returning entry with null size", () => {
    // Use a temp dir with NO files to simulate missing everything
    const emptyDir = mkdtempSync(join(tmpdir(), "gsd-manifest-empty-"));
    mkdirSync(join(emptyDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });

    const entries = inventoryContextFiles(emptyDir, "M001", "S01", "T01", []);

    // All 6 base entries should exist but most with null size
    assert.equal(entries.length, 6);

    // Task plan should be null (file doesn't exist in this dir)
    const taskPlan = entries.find(e => e.relPath.includes("T01-PLAN.md"));
    assert.ok(taskPlan);
    assert.equal(taskPlan.sizeBytes, null, "missing task plan should have null size");

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("includes prior summary paths as entries", () => {
    // Create a prior summary file
    const tasksDir = join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDid stuff");

    const priorPaths = [".gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md"];
    const entries = inventoryContextFiles(tmpDir, "M001", "S01", "T02", priorPaths);

    // 6 base + 1 prior summary = 7
    assert.equal(entries.length, 7);

    const summary = entries.find(e => e.relPath.includes("T01-SUMMARY.md"));
    assert.ok(summary, "should include prior summary entry");
    assert.ok(summary.purpose.includes("Dependency summary"));
    assert.ok(summary.purpose.includes("T01"), "should extract task ID for label");
    assert.ok(typeof summary.sizeBytes === "number" && summary.sizeBytes > 0);
  });

  it("handles missing prior summary files gracefully", () => {
    const priorPaths = [".gsd/milestones/M001/slices/S01/tasks/T99-SUMMARY.md"];
    const entries = inventoryContextFiles(tmpDir, "M001", "S01", "T02", priorPaths);

    const missing = entries.find(e => e.relPath.includes("T99-SUMMARY.md"));
    assert.ok(missing, "should still include the entry");
    assert.equal(missing.sizeBytes, null, "missing file should have null size");
  });
});

// ─── Integration: buildContextManifest + inventoryContextFiles ───────────────

describe("context-manifest: integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-manifest-int-"));
    const gsdDir = join(tmpDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    const milestoneDir = join(gsdDir, "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const sliceDir = join(milestoneDir, "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\nStep 1: do X\nStep 2: do Y");
    writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01 Plan\nGoal: deliver feature");
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(gsdDir, "DECISIONS.md"), "# Decisions");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inventoryContextFiles output feeds directly into buildContextManifest", () => {
    const entries = inventoryContextFiles(tmpDir, "M001", "S01", "T01", []);
    const manifest = buildContextManifest(entries);

    // Should be valid markdown table
    assert.ok(manifest.includes("## Context Manifest"));
    assert.ok(manifest.includes("| File | Purpose | Size |"));

    // Files that exist should show sizes, missing ones should show "(not yet created)"
    const lines = manifest.split("\n");
    const dataLines = lines.filter(l => l.startsWith("| `"));
    assert.ok(dataLines.length > 0, "should have data rows");

    // At least task plan should have a real size
    const taskPlanLine = dataLines.find(l => l.includes("T01-PLAN"));
    assert.ok(taskPlanLine, "should have task plan row");
    assert.ok(!taskPlanLine.includes("(not yet created)"), "existing file should show real size");
  });
});
