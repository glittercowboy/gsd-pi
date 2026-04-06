/**
 * auto-start-needs-discussion.test.ts — Regression tests for #1726.
 *
 * When a milestone has only CONTEXT-DRAFT.md (phase: needs-discussion),
 * bootstrapAutoSession had two bugs:
 *
 *   1. The survivor branch check included needs-discussion, so a branch
 *      created by a prior failed bootstrap caused hasSurvivorBranch = true,
 *      skipping all showSmartEntry calls.
 *
 *   2. No needs-discussion handler existed in the !hasSurvivorBranch block,
 *      so the phase fell through to auto-mode which immediately stopped
 *      with "needs its own discussion before planning."
 *
 * Together these created an infinite loop: /gsd creates worktree + branch,
 * stops immediately, next run detects the branch and skips entry, auto-mode
 * dispatches needs-discussion → stop, repeat.
 *
 * These tests verify:
 *   - deriveState correctly identifies needs-discussion phase
 *   - Full context + roadmap moves past needs-discussion
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState } from "../state.ts";
import { invalidateAllCaches } from "../cache.ts";

// ─── Fixture Helpers ─────────────────────────────────────────────────────────

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-needs-discussion-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeContextDraft(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT-DRAFT.md`), content);
}

function writeContext(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), content);
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-start-needs-discussion (#1726)", () => {
  let base: string;

  beforeEach(() => {
    base = createBase();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("CONTEXT-DRAFT.md only → needs-discussion phase", async () => {
    writeContextDraft(base, "M001", "# Draft\nSeed discussion.");
    invalidateAllCaches();
    const state = await deriveState(base);
    assert.strictEqual(state.phase, "needs-discussion",
      "milestone with only CONTEXT-DRAFT should be needs-discussion");
    assert.ok(!!state.activeMilestone,
      "activeMilestone should be set for needs-discussion");
    assert.strictEqual(state.activeMilestone?.id, "M001",
      "activeMilestone.id should be M001");
  });

  test("full context + roadmap → not needs-discussion", async () => {
    writeContextDraft(base, "M001", "# Draft\nSeed discussion.");
    writeContext(base, "M001", "# Context\nFull context.");
    writeRoadmap(base, "M001",
      "# M001: Test\n\n## Slices\n- [ ] **S01: Test Slice** `risk:low` `depends:[]`\n  > After this: works\n");
    invalidateAllCaches();
    const state = await deriveState(base);
    assert.ok(state.phase !== "needs-discussion",
      "milestone with full context + roadmap should NOT be needs-discussion");
  });
});
