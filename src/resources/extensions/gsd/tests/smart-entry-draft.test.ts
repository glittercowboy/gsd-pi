import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState } from "../state.js";
import { resolveMilestoneFile } from "../paths.js";
import { extractSourceRegion } from "./test-helpers.ts";

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

// ─── Fixture: milestone with only CONTEXT-DRAFT.md ──────────────────────

const tmpBase = mkdtempSync(join(tmpdir(), "gsd-smart-entry-draft-test-"));
const gsd = join(tmpBase, ".gsd");

mkdirSync(join(gsd, "milestones", "M001"), { recursive: true });

const draftContent = `# M001: Test Milestone — Context\n\n**Status:** Draft\n\nSeed material from a prior discussion.\n`;
writeFileSync(
  join(gsd, "milestones", "M001", "M001-CONTEXT-DRAFT.md"),
  draftContent,
);

// ─── Test: deriveState returns 'needs-discussion' for draft-only milestone ───

const state = await deriveState(tmpBase);

assert(
  state.phase === "needs-discussion",
  `phase should be 'needs-discussion' for draft-only milestone, got: "${state.phase}"`,
);

assert(
  state.activeMilestone?.id === "M001",
  `active milestone should be M001, got: "${state.activeMilestone?.id}"`,
);

// ─── Test: resolveMilestoneFile resolves CONTEXT-DRAFT ─────────────────────

const draftFile = resolveMilestoneFile(tmpBase, "M001", "CONTEXT-DRAFT");

assert(
  draftFile !== null && draftFile !== undefined,
  `resolveMilestoneFile should resolve CONTEXT-DRAFT, got: ${draftFile}`,
);

assert(
  draftFile!.endsWith("M001-CONTEXT-DRAFT.md"),
  `resolved path should end with M001-CONTEXT-DRAFT.md, got: "${draftFile}"`,
);

// ─── Test: CONTEXT.md is NOT resolved (only draft exists) ──────────────────

const contextFile = resolveMilestoneFile(tmpBase, "M001", "CONTEXT");

assert(
  contextFile === null || contextFile === undefined,
  `resolveMilestoneFile should NOT resolve CONTEXT when only CONTEXT-DRAFT exists, got: "${contextFile}"`,
);

// ─── Static: guided-flow.ts has 'needs-discussion' branch ─────────────────

const guidedFlowSource = readFileSync(
  join(import.meta.dirname, "..", "guided-flow.ts"),
  "utf-8",
);

assert(
  guidedFlowSource.includes('state.phase === "needs-discussion"'),
  "guided-flow.ts should have 'needs-discussion' phase check in showSmartEntry",
);

// Check the branch has draft-aware menu options
const branchIdx = guidedFlowSource.indexOf('state.phase === "needs-discussion"');
const branchChunk = extractSourceRegion(guidedFlowSource, 'state.phase === "needs-discussion"');

assert(
  branchChunk.includes("discuss_draft"),
  "needs-discussion branch should have 'discuss_draft' option",
);

assert(
  branchChunk.includes("discuss_fresh"),
  "needs-discussion branch should have 'discuss_fresh' option",
);

assert(
  branchChunk.includes("skip_milestone"),
  "needs-discussion branch should have 'skip_milestone' option",
);

assert(
  branchChunk.includes("CONTEXT-DRAFT"),
  "needs-discussion branch should load CONTEXT-DRAFT via resolveMilestoneFile",
);

assert(
  branchChunk.includes("Draft Seed") || branchChunk.includes("draftContent"),
  "discuss_draft path should include draft content as seed in the dispatched prompt",
);

assert(
  branchChunk.includes("return"),
  "needs-discussion branch should return early (not fall through to generic no-roadmap menu)",
);

// ─── Cleanup ──────────────────────────────────────────────────────────────

rmSync(tmpBase, { recursive: true, force: true });

// ─── Results ──────────────────────────────────────────────────────────────

console.log(`\nsmart-entry-draft: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
