/**
 * milestone-transition-state-rebuild.test.ts — Tests for #1576 fix.
 *
 * Verifies that rebuildState() is called after milestone transitions so STATE.md
 * reflects the new active milestone.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

