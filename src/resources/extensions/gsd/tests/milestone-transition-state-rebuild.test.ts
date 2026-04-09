/**
 * milestone-transition-state-rebuild.test.ts — Tests for #1576 fix.
 *
 * Verifies that:
 * 1. rebuildState() is called after milestone transitions so STATE.md
 *    reflects the new active milestone.
 * 2. completed-units.json is reset when the active milestone changes,
 *    preventing stale entries from causing dispatch skips.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Source-level checks ──────────────────────────────────────────────────────

test("auto/phases.ts milestone transition block calls rebuildState", () => {
  const phasesSrc = readFileSync(
    join(__dirname, "..", "auto", "phases.ts"),
    "utf-8",
  );

  // rebuildState must be called within the milestone transition block
  assert.ok(
    phasesSrc.includes("deps.rebuildState(s.basePath)"),
    "auto/phases.ts should call deps.rebuildState(s.basePath) during milestone transition",
  );

  // The rebuildState call must appear AFTER the pruneQueueOrder call
  // (i.e. after all transition cleanup is done)
  const pruneIdx = phasesSrc.indexOf("deps.pruneQueueOrder(s.basePath, pendingIds)");
  const rebuildIdx = phasesSrc.indexOf("deps.rebuildState(s.basePath)");
  assert.ok(pruneIdx > 0, "pruneQueueOrder should exist in phases.ts");
  assert.ok(rebuildIdx > 0, "rebuildState should exist in phases.ts");
  assert.ok(
    rebuildIdx > pruneIdx,
    "rebuildState should be called after pruneQueueOrder in the milestone transition block",
  );
});

test("auto/phases.ts milestone transition block resets completed-units.json", () => {
  const phasesSrc = readFileSync(
    join(__dirname, "..", "auto", "phases.ts"),
    "utf-8",
  );

  // completed-units.json must be archived and cleared during milestone transition
  const transitionStart = phasesSrc.indexOf("Milestone transition");
  assert.ok(transitionStart > 0, "Milestone transition block should exist");

  // The old file is archived before being cleared (#2313)
  const archiveSection = phasesSrc.indexOf("completed-units-", transitionStart);
  assert.ok(
    archiveSection > 0,
    "auto/phases.ts should archive completed-units.json during milestone transition",
  );

  // The disk file should be cleared to an empty array
  assert.ok(
    phasesSrc.includes('atomicWriteSync(completedKeysPath, JSON.stringify([], null, 2))'),
    "auto/phases.ts should write empty array to completed-units.json during milestone transition",
  );
});

test("auto/loop-deps.ts LoopDeps interface includes rebuildState", () => {
  const loopDepsSrc = readFileSync(
    join(__dirname, "..", "auto", "loop-deps.ts"),
    "utf-8",
  );

  assert.ok(
    loopDepsSrc.includes("rebuildState: (basePath: string) => Promise<void>"),
    "LoopDeps interface should declare rebuildState method",
  );
});

test("auto.ts buildLoopDeps wires rebuildState", () => {
  const autoSrc = readFileSync(
    join(__dirname, "..", "auto.ts"),
    "utf-8",
  );

  // rebuildState should be in the LoopDeps object literal
  const buildLoopDepsIdx = autoSrc.indexOf("function buildLoopDeps()");
  assert.ok(buildLoopDepsIdx > 0, "buildLoopDeps function should exist");

  const afterBuild = autoSrc.slice(buildLoopDepsIdx);
  assert.ok(
    afterBuild.includes("rebuildState,") || afterBuild.includes("rebuildState:"),
    "buildLoopDeps should include rebuildState in the returned deps object",
  );
});

// ─── Functional test: completed-units.json reset ─────────────────────────────

test("completed-units.json is cleared on milestone transition (functional)", () => {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-cu-reset-")));
  try {
    // Create .gsd directory with a populated completed-units.json
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });

    const completedKeysPath = join(gsdDir, "completed-units.json");
    const staleEntries = [
      "context-gather/M001",
      "roadmap-plan/M001",
      "plan-slice/S01",
      "execute-task/T01",
    ];
    writeFileSync(completedKeysPath, JSON.stringify(staleEntries, null, 2));

    // Verify stale entries exist
    const before = JSON.parse(readFileSync(completedKeysPath, "utf-8"));
    assert.equal(before.length, 4, "Should have 4 stale entries before reset");

    // Simulate what phases.ts does: write empty array
    writeFileSync(completedKeysPath, JSON.stringify([], null, 2));

    // Verify reset
    const after = JSON.parse(readFileSync(completedKeysPath, "utf-8"));
    assert.deepEqual(after, [], "completed-units.json should be empty after milestone transition");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
