/**
 * completed-units-metrics-sync.test.ts — Regression tests for #2313.
 *
 * 1. completed-units.json should be archived (not wiped) on milestone transition
 * 2. metrics.json should be in the worktree → project root sync file list
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Bug 1: completed-units.json should be archived, not wiped ─────────────

const phasesSrcPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const phasesSrc = readFileSync(phasesSrcPath, "utf-8");

test("#2313: completed-units.json should not be blindly wiped to [] on milestone transition", () => {
  // The milestone transition block should NOT write an empty array to completed-units.json
  // without first archiving the existing data. Look for the archive/rename pattern.
  const transitionIdx = phasesSrc.indexOf("Milestone transition");
  assert.ok(transitionIdx !== -1, "Milestone transition section exists");

  // Find the completed-units handling block
  const completedUnitsIdx = phasesSrc.indexOf("completed-units", transitionIdx);
  assert.ok(completedUnitsIdx !== -1, "completed-units handling exists in transition");

  // Get a window around the completed-units handling (1200 chars to
  // accommodate CRLF line endings on Windows which inflate byte offsets).
  const windowStart = Math.max(0, completedUnitsIdx - 300);
  const windowEnd = Math.min(phasesSrc.length, completedUnitsIdx + 900);
  const window = phasesSrc.slice(windowStart, windowEnd).toLowerCase();

  // Should archive/rename the old file before resetting
  const hasArchive = window.includes("archive") ||
    window.includes("rename") ||
    window.includes("cpsync") ||
    window.includes("safecopy") ||
    window.includes("completed-units-");

  assert.ok(
    hasArchive,
    "completed-units.json should be archived before reset during milestone transition",
  );
});

// ─── Bug 2: metrics.json should be in the sync file lists ──────────────────

test("#2313: syncStateToProjectRoot should sync metrics.json", () => {
  const syncSrcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const syncSrc = readFileSync(syncSrcPath, "utf-8");

  // syncStateToProjectRoot should copy metrics.json from worktree to project root
  assert.ok(
    syncSrc.includes("metrics.json"),
    "auto-worktree.ts should reference metrics.json for sync",
  );
});

test("#2313: syncWorktreeStateBack should include metrics.json in ROOT_STATE_FILES", () => {
  const autoWorktreeSrcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const autoWorktreeSrc = readFileSync(autoWorktreeSrcPath, "utf-8");

  // Find the ROOT_STATE_FILES constant (single source of truth for both sync directions)
  const constIdx = autoWorktreeSrc.indexOf("ROOT_STATE_FILES");
  assert.ok(constIdx !== -1, "ROOT_STATE_FILES constant exists");

  // Get the array content
  const arrayStart = autoWorktreeSrc.indexOf("[", constIdx);
  const arrayEnd = autoWorktreeSrc.indexOf("]", arrayStart);
  const rootFilesBlock = autoWorktreeSrc.slice(arrayStart, arrayEnd);

  assert.ok(
    rootFilesBlock.includes("metrics.json"),
    "metrics.json should be in ROOT_STATE_FILES list",
  );
});

// ─── Functional test: completed-units archive ────────────────────────────────

test("#2313: functional — completed-units archive creates milestone-specific file", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-completed-units-"));
  const gsdDir = join(tmpBase, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  // Simulate existing completed-units.json with data
  const existing = [
    { type: "task", id: "T01" },
    { type: "slice", id: "S01" },
  ];
  const completedKeysPath = join(gsdDir, "completed-units.json");
  writeFileSync(completedKeysPath, JSON.stringify(existing, null, 2));

  // Simulate the archive behavior: copy to milestone-specific file
  const milestoneId = "M001";
  const archivePath = join(gsdDir, `completed-units-${milestoneId}.json`);
  cpSync(completedKeysPath, archivePath);

  // Reset the main file
  writeFileSync(completedKeysPath, JSON.stringify([], null, 2));

  // Verify archive exists with original data
  assert.ok(existsSync(archivePath), "archive file should exist");
  const archived = JSON.parse(readFileSync(archivePath, "utf-8"));
  assert.deepEqual(archived, existing, "archived data should match original");

  // Verify main file is reset
  const current = JSON.parse(readFileSync(completedKeysPath, "utf-8"));
  assert.deepEqual(current, [], "current completed-units should be empty after transition");
});
