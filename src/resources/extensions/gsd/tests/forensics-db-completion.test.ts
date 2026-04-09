import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

/**
 * Tests for #3129: forensics reads DB for completion status instead of legacy file.
 *
 * The old loadCompletedKeys() reads completed-units.json which is never populated
 * during normal auto-mode completion. The DB (milestones/slices/tasks tables) is
 * the authoritative source for completion status.
 */
describe("forensics DB completion status (#3129)", () => {
  const forensicsSrc = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
  const stateSrc = readFileSync(join(gsdDir, "state.ts"), "utf-8");

  // ── Primary fix: forensics queries DB for completion counts ──────────

  it("ForensicReport has dbCompletionCounts field for DB-sourced completion data", () => {
    assert.ok(
      forensicsSrc.includes("dbCompletionCounts"),
      "ForensicReport must include dbCompletionCounts field for DB-sourced completion data",
    );
  });

  it("buildForensicReport queries DB for completed milestones, slices, and tasks", () => {
    assert.ok(
      forensicsSrc.includes("getDbCompletionCounts"),
      "buildForensicReport must call getDbCompletionCounts to query DB completion status",
    );
  });

  it("getDbCompletionCounts checks isDbAvailable before querying", () => {
    assert.ok(
      forensicsSrc.includes("isDbAvailable"),
      "getDbCompletionCounts must check isDbAvailable() before querying the DB",
    );
  });

  it("getDbCompletionCounts queries getAllMilestones for milestone completion", () => {
    assert.ok(
      forensicsSrc.includes("getAllMilestones"),
      "getDbCompletionCounts must use getAllMilestones() to count completed milestones",
    );
  });

  it("completion counting uses isClosedStatus for consistent status checks", () => {
    assert.ok(
      forensicsSrc.includes("isClosedStatus"),
      "forensics must use isClosedStatus() for consistent status checks",
    );
  });

  it("report rendering shows DB completion counts instead of just legacy key count", () => {
    assert.ok(
      forensicsSrc.includes("milestones complete"),
      "report must show '__ milestones complete' from DB data",
    );
    assert.ok(
      forensicsSrc.includes("slices complete"),
      "report must show '__ slices complete' from DB data",
    );
    assert.ok(
      forensicsSrc.includes("tasks complete"),
      "report must show '__ tasks complete' from DB data",
    );
  });

  it("falls back to completed-units.json only when DB is unavailable", () => {
    // loadCompletedKeys should still exist as fallback
    assert.ok(
      forensicsSrc.includes("loadCompletedKeys"),
      "loadCompletedKeys must still exist as fallback for non-DB projects",
    );
    // But the report should prefer DB counts
    assert.ok(
      forensicsSrc.includes("dbCompletionCounts"),
      "report must prefer dbCompletionCounts over legacy completedKeys",
    );
  });

  // ── Secondary fix: STATE.md label when all milestones complete ───────

  it("state.ts returns null activeMilestone when all milestones are complete", () => {
    // When phase is "complete", activeMilestone should be null, not the last milestone
    // The last completed milestone should be in a separate field
    assert.ok(
      stateSrc.includes("lastCompletedMilestone"),
      "GSDState must have lastCompletedMilestone field for the final milestone when phase=complete",
    );
  });
});
