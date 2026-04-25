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
 *   - The survivor branch filter in auto-start.ts excludes needs-discussion
 *   - The !hasSurvivorBranch block has a needs-discussion handler
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { deriveState } from "../state.ts";
import { invalidateAllCaches } from "../cache.ts";

// ─── Fixture Helpers ─────────────────────────────────────────────────────────

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-needs-discussion-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
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

// ─── Source code analysis helper ─────────────────────────────────────────────

function readAutoStartSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  return readFileSync(join(thisDir, "..", "auto-start.ts"), "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("auto-start-needs-discussion (#1726)", () => {

  test("1. CONTEXT-DRAFT.md only → needs-discussion phase", async () => {
    const base = createBase();
    try {
      writeContextDraft(base, "M001", "# Draft\nSeed discussion.");
      invalidateAllCaches();
      const state = await deriveState(base);
      assert.strictEqual(state.phase, "needs-discussion",
        "milestone with only CONTEXT-DRAFT should be needs-discussion");
      assert.ok(!!state.activeMilestone,
        "activeMilestone should be set for needs-discussion");
      assert.strictEqual(state.activeMilestone?.id, "M001",
        "activeMilestone.id should be M001");
    } finally {
      cleanup(base);
    }
  });

  test("2. Survivor branch check excludes needs-discussion", () => {
    const source = readAutoStartSource();

    // Find the survivor branch check block (Milestone branch recovery comment)
    const survivorBlock = source.match(
      /\/\/ Milestone branch recovery.*?hasSurvivorBranch = nativeBranchExists/s,
    );
    assert.ok(!!survivorBlock,
      "found survivor branch check block in auto-start.ts");

    if (survivorBlock) {
      const block = survivorBlock[0];
      // The condition should only check pre-planning, NOT needs-discussion
      assert.ok(!block.includes("needs-discussion"),
        "survivor branch filter must NOT include needs-discussion phase");
      assert.ok(block.includes("pre-planning"),
        "survivor branch filter should include pre-planning phase");
    }
  });

  test("3. needs-discussion handler exists in bootstrap", () => {
    const source = readAutoStartSource();

    // After the pre-planning handler, there should be a needs-discussion handler
    // that calls showSmartEntry
    const needsDiscussionHandler = source.match(
      /if\s*\(state\.phase\s*===\s*"needs-discussion"\)\s*\{[^}]*showSmartEntry/s,
    );
    assert.ok(!!needsDiscussionHandler,
      "needs-discussion handler calling showSmartEntry must exist in !hasSurvivorBranch block");
  });

  test("4. needs-discussion handler has abort path", () => {
    const source = readAutoStartSource();

    // The handler should check postState.phase !== "needs-discussion" and abort
    // if discussion didn't promote the draft
    assert.ok(
      source.includes('postState.phase !== "needs-discussion"'),
      "needs-discussion handler must check if phase advanced after showSmartEntry",
    );
    assert.ok(
      source.includes("milestone draft was not promoted"),
      "needs-discussion handler must have abort message when draft not promoted",
    );
  });

  test("5. Full context + roadmap → not needs-discussion", async () => {
    const base = createBase();
    try {
      writeContextDraft(base, "M001", "# Draft\nSeed discussion.");
      writeContext(base, "M001", "# Context\nFull context.");
      writeRoadmap(base, "M001",
        "# M001: Test\n\n## Slices\n- [ ] **S01: Test Slice** `risk:low` `depends:[]`\n  > After this: works\n");
      invalidateAllCaches();
      const state = await deriveState(base);
      assert.ok(state.phase !== "needs-discussion",
        "milestone with full context + roadmap should NOT be needs-discussion");
    } finally {
      cleanup(base);
    }
  });

  // Tests 6 and 7 removed in the #4832 follow-up.
  //
  // They source-grepped `auto-start.ts` for specific regex patterns like
  // `if (hasSurvivorBranch && state.phase === "needs-discussion")` —
  // which broke (correctly so) when the three-way survivor decision was
  // extracted into the `decideSurvivorAction` pure helper. The
  // behavioural invariants they were trying to uphold are now covered
  // directly in `survivor-branch-complete.test.ts`:
  //   - (hasSurvivor=true, phase="needs-discussion") → "discuss"
  //   - (hasSurvivor=false, phase="needs-discussion") → "none"
  //   - (hasSurvivor=true, phase=other)              → "none"
  // Those tests fail on real decision regressions without the
  // source-grep brittleness. Tests 1–5 above remain — they hit
  // `deriveState` on real fixtures and defend the #1726 infinite-loop
  // fix end-to-end.
});
