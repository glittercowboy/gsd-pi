/**
 * Regression test for #3475: guided-flow must rebuild STATE.md from derived
 * state before dispatching workflows.
 *
 * Verifies that buildStateMarkdown() produces content matching the derived
 * state (not a stale on-disk cache), and that the rebuild helper is wired
 * correctly from doctor.ts.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState, invalidateStateCache } from "../state.ts";
import { buildStateMarkdown, rebuildState } from "../doctor.ts";
import { resolveGsdRootFile } from "../paths.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-guided-state-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("guided-flow STATE.md rebuild (#3475)", () => {
  let base: string;

  afterEach(() => {
    closeDatabase();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("rebuildState writes STATE.md matching derived state, not stale cache", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // Set up real active milestone M010
    insertMilestone({ id: "M010", title: "Real Active", status: "active" });
    insertSlice({ id: "S03", milestoneId: "M010", title: "Slice Three", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T05", sliceId: "S03", milestoneId: "M010", title: "Task Five", status: "pending" });
    writeFile(base, "milestones/M010/M010-CONTEXT.md", "# M010: Real Active\n\nReal work here.");
    writeFile(base, "milestones/M010/M010-ROADMAP.md", "# M010\n\n## Slices\n\n- [ ] **S03: Slice Three**");

    // Write a STALE STATE.md pointing to wrong milestone
    writeFile(base, "STATE.md", [
      "# GSD State",
      "",
      "**Active Milestone:** M008: Old Queued",
      "**Active Slice:** None",
      "**Phase:** pre-planning",
      "",
      "## Next Action",
      "Milestone M008 has a roadmap but no slices defined.",
    ].join("\n"));

    // Derive state — should return M010
    invalidateStateCache();
    const state = await deriveState(base);
    assert.equal(state.activeMilestone?.id, "M010", "Derived state should be M010");

    // Rebuild STATE.md
    await rebuildState(base);

    // Read the rebuilt STATE.md
    const statePath = resolveGsdRootFile(base, "STATE");
    const rebuilt = readFileSync(statePath, "utf-8");

    // Should contain M010, NOT M008
    assert.ok(rebuilt.includes("M010"), "Rebuilt STATE.md should reference M010");
    assert.ok(!rebuilt.includes("M008"), "Rebuilt STATE.md should NOT reference stale M008");
  });

  test("buildStateMarkdown produces correct active milestone from GSDState", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    insertMilestone({ id: "M070", title: "Current Work", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "First Slice", status: "active", risk: "low", depends: [] });
    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Current Work");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070\n\n## Slices\n\n- [ ] **S01: First Slice**");

    invalidateStateCache();
    const state = await deriveState(base);
    const md = buildStateMarkdown(state);

    assert.ok(md.includes("M070"), "State markdown should include active milestone M070");
    assert.ok(md.includes("Current Work") || md.includes("M070"), "State markdown should include milestone title or ID");
  });
});
