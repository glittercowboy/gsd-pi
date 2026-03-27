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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildExistingMilestonesContext } from "../../guided-flow-queue.ts";
import type { GSDState, MilestoneRegistryEntry } from "../../types.ts";
import { createTestContext } from "../test-helpers.ts";

const { assertTrue, assertEq, report } = createTestContext();

// ─── Fixture: project with many completed milestones ─────────────────────

const tmpBase = mkdtempSync(join(tmpdir(), "gsd-queue-perf-"));
const gsd = join(tmpBase, ".gsd");
mkdirSync(join(gsd, "milestones"), { recursive: true });

const COMPLETED_COUNT = 25;
const ACTIVE_COUNT = 1;
const PENDING_COUNT = 2;

const allMilestoneIds: string[] = [];
const registry: MilestoneRegistryEntry[] = [];

// Create 25 completed milestones with CONTEXT.md and SUMMARY.md files
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

// Create 1 active milestone
{
  const mid = `M${String(COMPLETED_COUNT + 1).padStart(3, "0")}`;
  allMilestoneIds.push(mid);
  registry.push({ id: mid, title: "Active milestone", status: "active" });
  mkdirSync(join(gsd, "milestones", mid), { recursive: true });
  writeFileSync(
    join(gsd, "milestones", mid, `${mid}-CONTEXT.md`),
    `# ${mid}: Active milestone\n\nCurrently in progress.\n`,
  );
  writeFileSync(
    join(gsd, "milestones", mid, `${mid}-ROADMAP.md`),
    `# ${mid} Roadmap\n\nSlices planned.\n`,
  );
}

// Create 2 pending milestones
for (let i = 0; i < PENDING_COUNT; i++) {
  const mid = `M${String(COMPLETED_COUNT + ACTIVE_COUNT + 1 + i).padStart(3, "0")}`;
  allMilestoneIds.push(mid);
  registry.push({ id: mid, title: `Pending milestone ${i + 1}`, status: "pending" });
  mkdirSync(join(gsd, "milestones", mid), { recursive: true });
  writeFileSync(
    join(gsd, "milestones", mid, `${mid}-CONTEXT.md`),
    `# ${mid}: Pending milestone ${i + 1}\n\nQueued work.\n`,
  );
}

const state: GSDState = {
  activeMilestone: { id: `M${String(COMPLETED_COUNT + 1).padStart(3, "0")}`, title: "Active milestone" },
  activeSlice: null,
  activeTask: null,
  phase: "executing",
  recentDecisions: [],
  blockers: [],
  nextAction: "",
  registry,
};

// ─── Test: completed milestones should NOT have their files loaded ────────

console.log("\n=== Queue completed milestone performance (#2379) ===");

const context = await buildExistingMilestonesContext(tmpBase, allMilestoneIds, state);

// Active and pending milestones SHOULD have full context loaded
const activeMid = `M${String(COMPLETED_COUNT + 1).padStart(3, "0")}`;
assertTrue(
  context.includes("Currently in progress"),
  "Active milestone context content should be loaded",
);
assertTrue(
  context.includes("Slices planned"),
  "Active milestone roadmap should be loaded",
);

for (let i = 0; i < PENDING_COUNT; i++) {
  const mid = `M${String(COMPLETED_COUNT + ACTIVE_COUNT + 1 + i).padStart(3, "0")}`;
  assertTrue(
    context.includes(`Pending milestone ${i + 1}`),
    `Pending milestone ${mid} context should be loaded`,
  );
}

// Completed milestones should NOT have their CONTEXT.md body or SUMMARY.md
// content loaded — only a status line
for (let i = 1; i <= COMPLETED_COUNT; i++) {
  const mid = `M${String(i).padStart(3, "0")}`;

  // Should still mention the milestone ID and status
  assertTrue(
    context.includes(mid),
    `Completed milestone ${mid} should still be referenced`,
  );

  // Should NOT contain the heavy context body text
  assertTrue(
    !context.includes(`This is a large context document for ${mid}`),
    `Completed milestone ${mid} should NOT have its full CONTEXT.md body loaded`,
  );

  // Should NOT contain the summary body
  assertTrue(
    !context.includes(`Delivered feature ${i} successfully`),
    `Completed milestone ${mid} should NOT have its SUMMARY.md body loaded`,
  );
}

// ─── Test: the overall context should be reasonable in size ──────────────

// With 25 completed milestones NOT loading files, the context should be
// significantly smaller than if all files were loaded
const contextLines = context.split("\n").length;
assertTrue(
  contextLines < 200,
  `Context should be concise (got ${contextLines} lines); completed milestones should not inflate it`,
);

// ─── Cleanup ──────────────────────────────────────────────────────────────

rmSync(tmpBase, { recursive: true, force: true });

report();
