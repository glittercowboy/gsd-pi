import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState, invalidateStateCache } from "../state.js";
import { resolveMilestoneFile, clearPathCache } from "../paths.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// ─── Full state transition: needs-discussion → pre-planning ─────────────

console.log("=== Draft promotion: full state transition ===");

const tmpBase = mkdtempSync(join(tmpdir(), "gsd-draft-promotion-test-"));
const gsd = join(tmpBase, ".gsd");

mkdirSync(join(gsd, "milestones", "M001"), { recursive: true });

// Step 1: Create CONTEXT-DRAFT.md only → needs-discussion
const draftPath = join(gsd, "milestones", "M001", "M001-CONTEXT-DRAFT.md");
writeFileSync(draftPath, "# M001: Draft\n\nSeed material.\n");

const state1 = await deriveState(tmpBase);
assert(
  state1.phase === "needs-discussion",
  `draft-only should be 'needs-discussion', got: "${state1.phase}"`,
);

// Step 2: Write CONTEXT.md (simulating discussion output) → pre-planning
const contextPath = join(gsd, "milestones", "M001", "M001-CONTEXT.md");
writeFileSync(contextPath, "# M001: Full Context\n\nDeep discussion output.\n");

clearPathCache();
invalidateStateCache();
const state2 = await deriveState(tmpBase);
assert(
  state2.phase === "pre-planning",
  `after CONTEXT.md written, should be 'pre-planning', got: "${state2.phase}"`,
);

// Step 3: Simulate draft cleanup (what checkAutoStartAfterDiscuss does)
const resolvedDraft = resolveMilestoneFile(tmpBase, "M001", "CONTEXT-DRAFT");
assert(
  resolvedDraft !== null && resolvedDraft !== undefined,
  "CONTEXT-DRAFT.md should still exist before cleanup",
);

// Delete the draft (simulating the cleanup in checkAutoStartAfterDiscuss)
const { unlinkSync } = await import("node:fs");
try {
  if (resolvedDraft) unlinkSync(resolvedDraft);
} catch { /* non-fatal */ }

assert(
  !existsSync(draftPath),
  "CONTEXT-DRAFT.md should be deleted after promotion cleanup",
);

// Step 4: After cleanup, state is still pre-planning (CONTEXT.md exists)
clearPathCache();
invalidateStateCache();
const state3 = await deriveState(tmpBase);
assert(
  state3.phase === "pre-planning",
  `after cleanup, should still be 'pre-planning', got: "${state3.phase}"`,
);

// ─── No-draft case: cleanup is a no-op ──────────────────────────────────

console.log("=== No-draft cleanup: no-op ===");

const tmpBase2 = mkdtempSync(join(tmpdir(), "gsd-draft-promotion-noop-"));
const gsd2 = join(tmpBase2, ".gsd");

mkdirSync(join(gsd2, "milestones", "M001"), { recursive: true });
writeFileSync(
  join(gsd2, "milestones", "M001", "M001-CONTEXT.md"),
  "# M001: Normal\n\nStandard discussion output.\n",
);

// No CONTEXT-DRAFT.md exists — cleanup should be a no-op
const noDraft = resolveMilestoneFile(tmpBase2, "M001", "CONTEXT-DRAFT");
assert(
  noDraft === null || noDraft === undefined,
  "no CONTEXT-DRAFT.md should exist for standard discussion milestone",
);

// deriveState should return pre-planning normally
const state4 = await deriveState(tmpBase2);
assert(
  state4.phase === "pre-planning",
  `standard discussion milestone should be 'pre-planning', got: "${state4.phase}"`,
);

// ─── Both files exist → CONTEXT.md wins, draft cleanup works ───────────

console.log("=== Both files: CONTEXT wins, draft cleanable ===");

const tmpBase3 = mkdtempSync(join(tmpdir(), "gsd-draft-promotion-both-"));
const gsd3 = join(tmpBase3, ".gsd");

mkdirSync(join(gsd3, "milestones", "M001"), { recursive: true });
writeFileSync(
  join(gsd3, "milestones", "M001", "M001-CONTEXT.md"),
  "# M001: Full\n\nFull context.\n",
);
const bothDraftPath = join(gsd3, "milestones", "M001", "M001-CONTEXT-DRAFT.md");
writeFileSync(bothDraftPath, "# M001: Draft\n\nStale draft.\n");

const state5 = await deriveState(tmpBase3);
assert(
  state5.phase === "pre-planning",
  `both files: CONTEXT.md wins, should be 'pre-planning', got: "${state5.phase}"`,
);

// Cleanup the stale draft
const bothDraft = resolveMilestoneFile(tmpBase3, "M001", "CONTEXT-DRAFT");
try {
  if (bothDraft) unlinkSync(bothDraft);
} catch { /* non-fatal */ }

assert(
  !existsSync(bothDraftPath),
  "stale CONTEXT-DRAFT.md should be deleted in both-files case",
);

// ─── Static: guided-flow.ts has cleanup code ───────────────────────────

console.log("=== Static: cleanup code in guided-flow.ts ===");

const { readFileSync } = await import("node:fs");
const guidedFlowSource = readFileSync(
  join(import.meta.dirname, "..", "guided-flow.ts"),
  "utf-8",
);

const checkFnIdx = guidedFlowSource.indexOf("checkAutoStartAfterDiscuss");
const checkFnEnd = guidedFlowSource.indexOf("\nexport ", checkFnIdx + 1);
const checkFnChunk = guidedFlowSource.slice(checkFnIdx, checkFnEnd > checkFnIdx ? checkFnEnd : checkFnIdx + 5000);

assert(
  checkFnChunk.includes("CONTEXT-DRAFT"),
  "checkAutoStartAfterDiscuss should reference CONTEXT-DRAFT for cleanup",
);

assert(
  checkFnChunk.includes("unlinkSync"),
  "checkAutoStartAfterDiscuss should use unlinkSync to delete the draft",
);

// ─── Cleanup ──────────────────────────────────────────────────────────

rmSync(tmpBase, { recursive: true, force: true });
rmSync(tmpBase2, { recursive: true, force: true });
rmSync(tmpBase3, { recursive: true, force: true });

// ─── Results ──────────────────────────────────────────────────────────

console.log(`\ndraft-promotion: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
