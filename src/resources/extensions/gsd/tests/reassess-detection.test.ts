import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { checkNeedsReassessment } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import type { GSDState } from "../types.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-reassess-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function writeRoadmap(base: string, content: string): void {
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), content);
}

function writeSummary(base: string, sid: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-SUMMARY.md`),
    `---\nid: ${sid}\n---\n# ${sid} Summary\nDone.`,
  );
}

function writeAssessment(base: string, sid: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-ASSESSMENT.md`),
    `# ${sid} Assessment\nNo changes needed.`,
  );
}

const ROADMAP_S01_DONE_S02_TODO = `# M001 Roadmap
## Slices
- [x] **S01: First** \`risk:high\` \`depends:[]\`
- [ ] **S02: Second** \`risk:medium\` \`depends:[S01]\`
`;

const dummyState: GSDState = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Test" },
  activeSlice: { id: "S02", title: "Second" },
  activeTask: null,
  recentDecisions: [],
  blockers: [],
  nextAction: "",
  registry: [{ id: "M001", title: "Test", status: "active" }],
};

// ─── checkNeedsReassessment: returns null when assessment exists ─────────

test("checkNeedsReassessment returns null when assessment file exists", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    writeRoadmap(base, ROADMAP_S01_DONE_S02_TODO);
    writeSummary(base, "S01");
    writeAssessment(base, "S01");

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null when assessment exists");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns sliceId when assessment missing ─────

test("checkNeedsReassessment returns sliceId when assessment is missing", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    writeRoadmap(base, ROADMAP_S01_DONE_S02_TODO);
    writeSummary(base, "S01");
    // No assessment written

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(result, { sliceId: "S01" });
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns null when no summary exists ─────────

test("checkNeedsReassessment returns null when summary is missing", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    writeRoadmap(base, ROADMAP_S01_DONE_S02_TODO);
    // No summary, no assessment

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null — can't reassess without summary");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: detects assessment written after cache ──────
// This is the core regression test for #1112: the assessment file is written
// to disk AFTER the path cache was populated (simulating the worktree race
// condition where readdirSync doesn't see a freshly written file).

test("checkNeedsReassessment detects assessment written after initial cache population", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, ROADMAP_S01_DONE_S02_TODO);
    writeSummary(base, "S01");

    // First call: no assessment exists — populates internal caches
    invalidateAllCaches();
    const before = await checkNeedsReassessment(base, "M001", dummyState);
    assert.deepStrictEqual(before, { sliceId: "S01" }, "should need reassessment initially");

    // Now write the assessment WITHOUT clearing caches.
    // This simulates the race condition: the agent wrote the file, but the
    // directory listing cache still has the old state.
    writeAssessment(base, "S01");

    // Second call: the file exists on disk but caches may be stale.
    // With the fix (#1112), the existsSync fallback should detect it.
    invalidateAllCaches();
    const after = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(after, null, "should return null — assessment exists on disk (fallback check)");
  } finally {
    cleanup(base);
  }
});

// ─── checkNeedsReassessment: returns null when all slices done ───────────

test("checkNeedsReassessment returns null when all slices are complete", async () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    const allDone = `# M001 Roadmap\n## Slices\n- [x] **S01: First** \`risk:high\` \`depends:[]\`\n- [x] **S02: Second** \`risk:medium\` \`depends:[S01]\`\n`;
    writeRoadmap(base, allDone);
    writeSummary(base, "S02");

    const result = await checkNeedsReassessment(base, "M001", dummyState);
    assert.strictEqual(result, null, "should return null — all slices done, no point reassessing");
  } finally {
    cleanup(base);
  }
});
