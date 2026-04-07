/**
 * Regression test for #2379: /gsd queue fails with 429 rate limit on projects
 * with many completed milestones.
 *
 * The bug: buildExistingMilestonesContext iterates over ALL milestones
 * (including completed ones) and calls loadFile for CONTEXT, SUMMARY,
 * CONTEXT-DRAFT, and ROADMAP files on each — causing excessive I/O that
 * triggers rate limits on large projects.
 *
 * The fix: completed milestones should emit a short summary line without
 * loading their heavy artifact files (CONTEXT.md, SUMMARY.md, etc.).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildExistingMilestonesContext } from "../../guided-flow-queue.ts";
import type { GSDState, MilestoneRegistryEntry } from "../../types.ts";

describe("#2379: Queue completed milestone performance", () => {
  const COMPLETED_COUNT = 25;
  const ACTIVE_COUNT = 1;
  const PENDING_COUNT = 2;

  let tmpBase: string;
  let allMilestoneIds: string[];
  let state: GSDState;

  // Build the fixture once for all tests in this describe
  tmpBase = mkdtempSync(join(tmpdir(), "gsd-queue-perf-"));
  const gsd = join(tmpBase, ".gsd");
  mkdirSync(join(gsd, "milestones"), { recursive: true });

  allMilestoneIds = [];
  const registry: MilestoneRegistryEntry[] = [];

  for (let i = 1; i <= COMPLETED_COUNT; i++) {
    const mid = `M${String(i).padStart(3, "0")}`;
    allMilestoneIds.push(mid);
    registry.push({ id: mid, title: `Completed milestone ${i}`, status: "complete" });
    mkdirSync(join(gsd, "milestones", mid), { recursive: true });
    writeFileSync(
      join(gsd, "milestones", mid, `${mid}-CONTEXT.md`),
      `# ${mid}: Completed milestone ${i}\n\nThis is a large context document for ${mid}.\n${"Lorem ipsum dolor sit amet. ".repeat(50)}\n`,
    );
    writeFileSync(
      join(gsd, "milestones", mid, `${mid}-SUMMARY.md`),
      `# ${mid} Summary\n\nDelivered feature ${i} successfully.\n`,
    );
  }

  {
    const mid = `M${String(COMPLETED_COUNT + 1).padStart(3, "0")}`;
    allMilestoneIds.push(mid);
    registry.push({ id: mid, title: "Active milestone", status: "active" });
    mkdirSync(join(gsd, "milestones", mid), { recursive: true });
    writeFileSync(join(gsd, "milestones", mid, `${mid}-CONTEXT.md`), `# ${mid}: Active milestone\n\nCurrently in progress.\n`);
    writeFileSync(join(gsd, "milestones", mid, `${mid}-ROADMAP.md`), `# ${mid} Roadmap\n\nSlices planned.\n`);
  }

  for (let i = 0; i < PENDING_COUNT; i++) {
    const mid = `M${String(COMPLETED_COUNT + ACTIVE_COUNT + 1 + i).padStart(3, "0")}`;
    allMilestoneIds.push(mid);
    registry.push({ id: mid, title: `Pending milestone ${i + 1}`, status: "pending" });
    mkdirSync(join(gsd, "milestones", mid), { recursive: true });
    writeFileSync(join(gsd, "milestones", mid, `${mid}-CONTEXT.md`), `# ${mid}: Pending milestone ${i + 1}\n\nQueued work.\n`);
  }

  state = {
    activeMilestone: { id: `M${String(COMPLETED_COUNT + 1).padStart(3, "0")}`, title: "Active milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry,
  };

  test("active milestone context content is loaded", async (t) => {
    t.after(() => rmSync(tmpBase, { recursive: true, force: true }));
    const context = await buildExistingMilestonesContext(tmpBase, allMilestoneIds, state);
    assert.ok(context.includes("Currently in progress"));
    assert.ok(context.includes("Slices planned"));
  });

  test("pending milestones context is loaded", async () => {
    const context = await buildExistingMilestonesContext(tmpBase, allMilestoneIds, state);
    for (let i = 0; i < PENDING_COUNT; i++) {
      assert.ok(context.includes(`Pending milestone ${i + 1}`));
    }
  });

  test("completed milestones do NOT have full CONTEXT.md body loaded", async () => {
    const context = await buildExistingMilestonesContext(tmpBase, allMilestoneIds, state);
    for (let i = 1; i <= COMPLETED_COUNT; i++) {
      const mid = `M${String(i).padStart(3, "0")}`;
      assert.ok(context.includes(mid), `${mid} should be referenced`);
      assert.ok(!context.includes(`This is a large context document for ${mid}`), `${mid} full body should NOT be loaded`);
      assert.ok(!context.includes(`Delivered feature ${i} successfully`), `${mid} SUMMARY.md body should NOT be loaded`);
    }
  });

  test("overall context is concise (< 200 lines)", async () => {
    const context = await buildExistingMilestonesContext(tmpBase, allMilestoneIds, state);
    const contextLines = context.split("\n").length;
    assert.ok(contextLines < 200, `got ${contextLines} lines`);
  });
});
