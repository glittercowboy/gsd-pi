// GSD Extension — Write Intercept Unit Tests
// Tests for isBlockedStateFile path matching and BLOCKED_WRITE_ERROR message content.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBlockedStateFile, BLOCKED_WRITE_ERROR } from "../write-intercept.ts";

describe("write-intercept", () => {
  describe("isBlockedStateFile()", () => {
    it("returns true for .gsd/STATE.md", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/STATE.md"), true);
    });

    it("returns true for .gsd/REQUIREMENTS.md", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/REQUIREMENTS.md"), true);
    });

    it("returns false for .gsd/PROJECT.md (content file, agent-authored)", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/PROJECT.md"), false);
    });

    it("returns false for .gsd/milestones/M001/S01-PLAN.md (agent-authored during planning)", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/milestones/M001/S01-PLAN.md"), false);
    });

    it("returns false for .gsd/milestones/M001/ROADMAP.md (agent-authored during planning)", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/milestones/M001/ROADMAP.md"), false);
    });

    it("returns false for .gsd/milestones/M001/S01-SUMMARY.md (summaries are content)", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/milestones/M001/S01-SUMMARY.md"), false);
    });

    it("returns false for .gsd/KNOWLEDGE.md (content file)", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/KNOWLEDGE.md"), false);
    });

    it("returns false for .gsd/CONTEXT.md (content file)", () => {
      assert.equal(isBlockedStateFile("/project/.gsd/CONTEXT.md"), false);
    });

    it("returns false for /project/src/app.ts (not in .gsd/)", () => {
      assert.equal(isBlockedStateFile("/project/src/app.ts"), false);
    });

    it("returns true for symlink-resolved path under ~/.gsd/projects/ (Pitfall #6)", () => {
      // Simulate resolved symlink path pointing to project state
      assert.equal(isBlockedStateFile("/home/user/.gsd/projects/abc123/STATE.md"), true);
    });

    it("BLOCKED_WRITE_ERROR contains required tool call references", () => {
      assert.ok(BLOCKED_WRITE_ERROR.includes("gsd_complete_task"), "must reference gsd_complete_task");
      assert.ok(BLOCKED_WRITE_ERROR.includes("gsd_complete_slice"), "must reference gsd_complete_slice");
      assert.ok(BLOCKED_WRITE_ERROR.includes("gsd_save_decision"), "must reference gsd_save_decision");
    });
  });
});
