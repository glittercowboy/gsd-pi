/**
 * discuss-queued-milestones.test.ts — Tests for #2307.
 *
 * /gsd discuss was previously gated on state.activeMilestone, which prevented
 * users from discussing queued (pending) milestones during roadmap grooming.
 *
 * These tests verify:
 *   1. deriveState correctly identifies pending milestones (the set the picker
 *      will show when no active milestone is present)
 *   2. resolveMilestoneFile correctly resolves context artifacts for pending
 *      milestones so the picker can report their discussion state
 *   3. The guided-flow.ts source code no longer hard-exits when no active
 *      milestone exists but pending milestones are present
 *   4. The helper functions for queued discuss exist in the source
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
import { resolveMilestoneFile } from "../paths.ts";

// ─── Fixture Helpers ──────────────────────────────────────────────────────────

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-discuss-queued-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeMilestoneDir(base: string, mid: string): void {
  mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });
}

function writeContext(base: string, mid: string, content: string): void {
  writeMilestoneDir(base, mid);
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`), content);
}

function writeContextDraft(base: string, mid: string, content: string): void {
  writeMilestoneDir(base, mid);
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-CONTEXT-DRAFT.md`), content);
}

function writeRoadmap(base: string, mid: string, content: string): void {
  writeMilestoneDir(base, mid);
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-ROADMAP.md`), content);
}

function readGuidedFlowSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  return readFileSync(join(thisDir, "..", "guided-flow.ts"), "utf-8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("discuss-queued-milestones (#2307)", () => {

  test("1. pending milestones appear in registry when active milestone exists", async () => {
    const base = createBase();
    try {
      // M001: active — has context + roadmap with a slice
      writeContext(base, "M001", "# M001: Active\nContext here.");
      writeRoadmap(base, "M001",
        "# M001: Active\n\n## Slices\n- [ ] **S01: Do work** `risk:low` `depends:[]`\n  > After this: works\n");

      // M002: pending — context only, no roadmap
      writeContext(base, "M002", "# M002: Queued\nFuture work.");

      // M003: pending — draft context only
      writeContextDraft(base, "M003", "# M003: Draft\nSeed material.");

      invalidateAllCaches();
      const state = await deriveState(base);

      assert.ok(!!state.activeMilestone, "M001 should be the active milestone");
      assert.strictEqual(state.activeMilestone?.id, "M001");

      const pendingIds = state.registry
        .filter(m => m.status === "pending")
        .map(m => m.id);

      assert.ok(pendingIds.includes("M002"), "M002 should be pending");
      assert.ok(pendingIds.includes("M003"), "M003 should be pending");
    } finally {
      cleanup(base);
    }
  });

  test("2. first context-only milestone is active, subsequent ones are pending", async () => {
    const base = createBase();
    try {
      // M001: first milestone with context but no roadmap — deriveState marks it active
      writeContext(base, "M001", "# M001: First\nContext here.");
      // M002: will be pending since M001 is active
      writeContext(base, "M002", "# M002: Second\nMore future work.");

      invalidateAllCaches();
      const state = await deriveState(base);

      // deriveState makes the first unfinished milestone "active" even without a roadmap
      assert.ok(!!state.activeMilestone, "first milestone should be active");
      assert.strictEqual(state.activeMilestone?.id, "M001", "M001 is the active milestone");

      const pendingIds = state.registry
        .filter(m => m.status === "pending")
        .map(m => m.id);

      assert.ok(pendingIds.includes("M002"),
        "M002 should be pending — it comes after the active M001");
    } finally {
      cleanup(base);
    }
  });

  test("3. resolveMilestoneFile finds CONTEXT.md for pending milestone", (t) => {
    const base = createBase();
    try {
      writeContext(base, "M002", "# M002: Queued\nContent.");

      const contextFile = resolveMilestoneFile(base, "M002", "CONTEXT");
      assert.ok(contextFile !== null, "resolveMilestoneFile should find CONTEXT.md for M002");
      assert.ok(contextFile!.endsWith("M002-CONTEXT.md"),
        "resolved path should point to M002-CONTEXT.md");
    } finally {
      cleanup(base);
    }
  });

  test("4. resolveMilestoneFile finds CONTEXT-DRAFT.md for pending milestone", (t) => {
    const base = createBase();
    try {
      writeContextDraft(base, "M003", "# M003: Draft\nSeed content.");

      const draftFile = resolveMilestoneFile(base, "M003", "CONTEXT-DRAFT");
      assert.ok(draftFile !== null, "resolveMilestoneFile should find CONTEXT-DRAFT.md for M003");
      assert.ok(draftFile!.endsWith("M003-CONTEXT-DRAFT.md"),
        "resolved path should point to M003-CONTEXT-DRAFT.md");
    } finally {
      cleanup(base);
    }
  });

  test("5. resolveMilestoneFile returns null when pending milestone has no context", (t) => {
    const base = createBase();
    try {
      writeMilestoneDir(base, "M004");

      const contextFile = resolveMilestoneFile(base, "M004", "CONTEXT");
      assert.strictEqual(contextFile, null,
        "resolveMilestoneFile should return null when no CONTEXT.md exists");

      const draftFile = resolveMilestoneFile(base, "M004", "CONTEXT-DRAFT");
      assert.strictEqual(draftFile, null,
        "resolveMilestoneFile should return null when no CONTEXT-DRAFT.md exists");
    } finally {
      cleanup(base);
    }
  });

  test("6. guided-flow no longer hard-exits when no active milestone but pending exist", () => {
    const source = readGuidedFlowSource();

    // The old guard was a simple early-exit:
    //   if (!state.activeMilestone) {
    //     ctx.ui.notify("No active milestone. Run /gsd to create one first.", "warning");
    //     return;
    //   }
    //
    // The new guard should check for pending milestones and route instead.
    const oldGuardPattern = /if\s*\(!state\.activeMilestone\)\s*\{\s*ctx\.ui\.notify\("No active milestone/;
    assert.ok(
      !oldGuardPattern.test(source),
      "guided-flow must not unconditionally exit when activeMilestone is null",
    );
  });

  test("7. showDiscussQueuedMilestone helper exists in guided-flow", () => {
    const source = readGuidedFlowSource();
    assert.ok(
      source.includes("showDiscussQueuedMilestone"),
      "guided-flow must export showDiscussQueuedMilestone helper",
    );
  });

  test("8. dispatchDiscussForMilestone helper exists in guided-flow", () => {
    const source = readGuidedFlowSource();
    assert.ok(
      source.includes("dispatchDiscussForMilestone"),
      "guided-flow must export dispatchDiscussForMilestone helper",
    );
  });

  test("9. dispatchDiscussForMilestone does not set pendingAutoStart", () => {
    const source = readGuidedFlowSource();

    // Extract the dispatchDiscussForMilestone function body
    const fnMatch = source.match(
      /async function dispatchDiscussForMilestone\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
    );
    assert.ok(!!fnMatch, "dispatchDiscussForMilestone function body must be present");

    if (fnMatch) {
      assert.ok(
        !fnMatch[1].includes("pendingAutoStart"),
        "dispatchDiscussForMilestone must NOT set pendingAutoStart — discussing a queued milestone must not activate it",
      );
    }
  });

  test("10. slice picker includes queued milestone option when pending milestones exist", () => {
    const source = readGuidedFlowSource();
    assert.ok(
      source.includes("discuss_queued_milestone"),
      "slice picker must include a 'discuss_queued_milestone' action id for queued milestones",
    );
    assert.ok(
      source.includes("Discuss a queued milestone"),
      "slice picker must label the queued milestone action clearly",
    );
  });

  test("11. queued milestone picker labels entries with [queued]", () => {
    const source = readGuidedFlowSource();
    assert.ok(
      source.includes("[queued]"),
      "queued milestone picker must label entries with [queued] to distinguish from active",
    );
  });

  // ─── #3150: allDiscussed early-return must not block queued milestone discussion ──

  test("12. allDiscussed path checks for pending milestones before returning (#3150)", () => {
    const source = readGuidedFlowSource();

    // Extract the allDiscussed block — the if (allDiscussed) { ... } body
    const allDiscussedMatch = source.match(
      /const allDiscussed = pendingSlices\.every\([\s\S]*?\n    if \(allDiscussed\) \{([\s\S]*?)\n    \}/,
    );
    assert.ok(!!allDiscussedMatch, "allDiscussed guard block must exist in showDiscuss()");

    if (allDiscussedMatch) {
      const body = allDiscussedMatch[1];
      // The fix must check for pending milestones and route to showDiscussQueuedMilestone
      assert.ok(
        body.includes("pending") && body.includes("showDiscussQueuedMilestone"),
        "allDiscussed block must check for pending milestones and call showDiscussQueuedMilestone before returning (#3150)",
      );
    }
  });

  test("13. pendingSlices.length===0 path checks for pending milestones before returning (#3150)", () => {
    const source = readGuidedFlowSource();

    // Find the pendingSlices.length === 0 guard block
    const zeroSlicesMatch = source.match(
      /if \(pendingSlices\.length === 0\) \{([\s\S]*?)\n  \}/,
    );
    assert.ok(!!zeroSlicesMatch, "pendingSlices.length === 0 guard block must exist in showDiscuss()");

    if (zeroSlicesMatch) {
      const body = zeroSlicesMatch[1];
      // The fix must check for pending milestones and route to showDiscussQueuedMilestone
      assert.ok(
        body.includes("pending") && body.includes("showDiscussQueuedMilestone"),
        "pendingSlices.length===0 block must check for pending milestones and call showDiscussQueuedMilestone before returning (#3150)",
      );
    }
  });
});
