import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { deriveState } = await import("../state.js");
const { findMilestoneIds, nextMilestoneId, clearReservedMilestoneIds } = await import("../milestone-ids.js");

// ─── deriveState ────────────────────────────────────────────────────────────

describe("deriveState: complete phase", () => {
  let base: string;

  before(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-smart-entry-complete-"));
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(
      join(milestoneDir, "M001-ROADMAP.md"),
      [
        "# M001: Complete Milestone",
        "",
        "## Slices",
        "- [x] **S01: Done slice** `risk:low` `depends:[]`",
        "  > Done.",
      ].join("\n"),
    );
    writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# M001 Summary\n\nComplete.");
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reports complete when all milestone slices are done", async () => {
    const state = await deriveState(base);
    assert.equal(state.phase, "complete");
    assert.equal(state.activeMilestone?.id, "M001");
  });
});

// ─── findMilestoneIds ────────────────────────────────────────────────────────

describe("findMilestoneIds", () => {
  let base: string;

  before(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-milestone-ids-"));
    const milestonesDir = join(base, ".gsd", "milestones");
    mkdirSync(join(milestonesDir, "M001"), { recursive: true });
    mkdirSync(join(milestonesDir, "M002"), { recursive: true });
    mkdirSync(join(milestonesDir, "M003"), { recursive: true });
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns milestone IDs found in the milestones directory", () => {
    const ids = findMilestoneIds(base);
    assert.deepEqual(ids, ["M001", "M002", "M003"]);
  });

  it("returns empty array when milestones directory does not exist", () => {
    const emptyBase = mkdtempSync(join(tmpdir(), "gsd-milestone-ids-empty-"));
    try {
      assert.deepEqual(findMilestoneIds(emptyBase), []);
    } finally {
      rmSync(emptyBase, { recursive: true, force: true });
    }
  });
});

// ─── nextMilestoneId ─────────────────────────────────────────────────────────

describe("nextMilestoneId", () => {
  before(() => {
    clearReservedMilestoneIds();
  });

  it("returns M001 when no existing milestones", () => {
    assert.equal(nextMilestoneId([]), "M001");
  });

  it("returns M002 after M001", () => {
    assert.equal(nextMilestoneId(["M001"]), "M002");
  });

  it("returns M004 after M001–M003", () => {
    assert.equal(nextMilestoneId(["M001", "M002", "M003"]), "M004");
  });
});

// ─── complete phase: next ID derivation ──────────────────────────────────────

describe("complete phase: next milestone ID derivation", () => {
  let base: string;

  before(() => {
    clearReservedMilestoneIds();
    base = mkdtempSync(join(tmpdir(), "gsd-complete-next-id-"));
    const milestonesDir = join(base, ".gsd", "milestones");
    mkdirSync(join(milestonesDir, "M001"), { recursive: true });
    writeFileSync(join(milestonesDir, "M001", "M001-SUMMARY.md"), "# M001 Summary\n\nComplete.");
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("proposes M002 after M001 completes", () => {
    const milestoneIds = findMilestoneIds(base);
    const nextId = nextMilestoneId(milestoneIds);
    assert.equal(nextId, "M002");
  });
});
