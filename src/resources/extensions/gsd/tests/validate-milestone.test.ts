import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { deriveState, isValidationTerminal } from "../state.ts";
import { resolveExpectedArtifactPath, diagnoseExpectedArtifact } from "../auto-artifact-paths.ts";
import { verifyExpectedArtifact, buildLoopRemediationSteps } from "../auto-recovery.ts";
import { resolveDispatch, type DispatchContext } from "../auto-dispatch.ts";
import { buildValidateMilestonePrompt } from "../auto-prompts.ts";
import type { GSDState } from "../types.ts";
import { clearPathCache } from "../paths.ts";
import { clearParseCache } from "../files.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-val-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  clearPathCache();
  clearParseCache();
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function writeMilestoneSummary(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}

function writeValidation(base: string, mid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), content);
}

function writeSlicePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}

function writeSliceSummary(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-SUMMARY.md`), content);
}

function writeSliceAssessment(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-ASSESSMENT.md`), content);
}

const ALL_DONE_ROADMAP = `# M001: Test Milestone

## Vision
Test

## Success Criteria
- It works

## Slices

- [x] **S01: First slice** \`risk:low\` \`depends:[]\`
  > After this: it works

## Boundary Map

| From | To | Produces | Consumes |
|------|-----|----------|----------|
| S01  | terminal | output | nothing |
`;

const CONTEXT_FILE = `---
id: M001
title: Test Milestone
---

# Context
Test context.
`;

// ─── isValidationTerminal ─────────────────────────────────────────────────

test("isValidationTerminal returns true for verdict: pass", () => {
  const content = "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});

test("isValidationTerminal returns true for verdict: needs-attention", () => {
  const content = "---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});

test("isValidationTerminal returns true for verdict: needs-remediation (#832)", () => {
  // needs-remediation is treated as terminal to prevent infinite loops
  // when no remediation slices exist in the roadmap.
  const content = "---\nverdict: needs-remediation\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});

test("isValidationTerminal returns true for verdict: passed (#1429)", () => {
  const content = "---\nverdict: passed\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});

test("isValidationTerminal returns true for verdict: fail (#2769)", () => {
  const content = "---\nverdict: fail\nremediation_round: 1\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});

test("isValidationTerminal returns true for any arbitrary verdict string (#2769)", () => {
  const content = "---\nverdict: custom-verdict\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});

test("isValidationTerminal returns false for missing frontmatter", () => {
  const content = "# Validation\nNo frontmatter here.";
  assert.equal(isValidationTerminal(content), false);
});

test("isValidationTerminal returns false for missing verdict field", () => {
  const content = "---\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), false);
});

// ─── deriveState: validating-milestone ────────────────────────────────────

test("deriveState returns validating-milestone when all slices done and no VALIDATION file", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    // Write CONTEXT so milestone has a title
    const dir = join(base, ".gsd", "milestones", "M001");
    writeFileSync(join(dir, "M001-CONTEXT.md"), CONTEXT_FILE);

    const state = await deriveState(base);
    assert.equal(state.phase, "validating-milestone");
    assert.equal(state.activeMilestone?.id, "M001");
    assert.equal(state.activeSlice, null);
  } finally {
    cleanup(base);
  }
});

test("deriveState returns completing-milestone when VALIDATION exists with terminal verdict", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeValidation(base, "M001", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nAll good.");

    const state = await deriveState(base);
    assert.equal(state.phase, "completing-milestone");
    assert.equal(state.activeMilestone?.id, "M001");
  } finally {
    cleanup(base);
  }
});

test("deriveState treats needs-remediation as non-terminal — re-enters validating-milestone (#832)", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeValidation(base, "M001", "---\nverdict: needs-remediation\nremediation_round: 0\n---\n\n# Validation\nNeeds fixes.");

    const state = await deriveState(base);
    // needs-remediation routes back to validating-milestone for re-validation
    assert.equal(state.phase, "validating-milestone");
    assert.equal(state.activeMilestone?.id, "M001");
  } finally {
    cleanup(base);
  }
});

test("deriveState returns complete when both VALIDATION and SUMMARY exist", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeValidation(base, "M001", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.");
    writeMilestoneSummary(base, "M001", "# Summary\nDone.");

    const state = await deriveState(base);
    assert.equal(state.phase, "complete");
  } finally {
    cleanup(base);
  }
});

test("buildValidateMilestonePrompt inlines ASSESSMENT evidence instead of UAT spec", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    const dir = join(base, ".gsd", "milestones", "M001");
    writeFileSync(join(dir, "M001-CONTEXT.md"), CONTEXT_FILE);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDelivered.");
    writeFileSync(join(dir, "slices", "S01", "S01-UAT.md"), "# UAT Spec\nDo the thing.\n");
    writeSliceAssessment(base, "M001", "S01", "---\nverdict: PASS\n---\n# Assessment\nEvidence captured.");

    const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);
    assert.match(prompt, /S01 Assessment/i, "prompt should inline assessment evidence");
    assert.match(prompt, /verdict: PASS/i, "prompt should include the assessment verdict");
    assert.doesNotMatch(prompt, /UAT Spec/i, "prompt should not inline the raw UAT spec as evidence");
  } finally {
    cleanup(base);
  }
});

// ─── Dispatch rule ────────────────────────────────────────────────────────

test("dispatch rule matches validating-milestone phase", async () => {
  const state: GSDState = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "validating-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Validate milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } },
  };

  const base = makeTmpBase();
  try {
    // Set up minimal milestone structure for the prompt builder
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDone."); // Guard requires slice summaries (#1368)

    const ctx: DispatchContext = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: undefined,
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.unitType, "validate-milestone");
      assert.equal(result.unitId, "M001");
    }
  } finally {
    cleanup(base);
  }
});

test("dispatch rule skips when skip_milestone_validation preference is set", async () => {
  const state: GSDState = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "validating-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Validate milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } },
  };

  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDone."); // Guard requires slice summaries (#1368)

    const ctx: DispatchContext = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: { phases: { skip_milestone_validation: true } },
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "skip");

    // Verify the VALIDATION file was written
    const validationPath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.ok(existsSync(validationPath), "VALIDATION file should be written on skip");
  } finally {
    cleanup(base);
  }
});

// ─── Artifact resolution & verification ───────────────────────────────────

test("resolveExpectedArtifactPath returns VALIDATION path for validate-milestone", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    const result = resolveExpectedArtifactPath("validate-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result!.includes("VALIDATION"));
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact passes when VALIDATION.md exists", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nverdict: pass\n---\n# Val");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true);
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact fails when VALIDATION.md is missing", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false);
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rejects VALIDATION with missing frontmatter", () => {
  const base = makeTmpBase();
  try {
    // A VALIDATION file without frontmatter should be treated as incomplete —
    // matching what deriveState expects. Without this, the artifact check passes
    // but deriveState still returns validating-milestone, causing the hard skip loop.
    writeValidation(base, "M001", "# Validation\nNo frontmatter here.");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false, "VALIDATION without frontmatter should fail verification");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rejects VALIDATION with missing verdict field", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nremediation_round: 0\n---\n\n# Validation");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false, "VALIDATION without verdict field should fail verification");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts VALIDATION with any extracted verdict", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nverdict: unknown-value\nremediation_round: 0\n---\n\n# Validation");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true, "VALIDATION with any extracted verdict should pass verification");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact passes VALIDATION with needs-attention verdict", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation\nNeeds attention.");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true, "VALIDATION with needs-attention verdict should pass verification");
  } finally {
    cleanup(base);
  }
});

// ─── diagnoseExpectedArtifact ─────────────────────────────────────────────

test("diagnoseExpectedArtifact returns validation path for validate-milestone", () => {
  const base = makeTmpBase();
  try {
    const result = diagnoseExpectedArtifact("validate-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result!.includes("VALIDATION"));
    assert.ok(result!.includes("milestone validation report"));
  } finally {
    cleanup(base);
  }
});

// ─── buildLoopRemediationSteps ────────────────────────────────────────────

test("buildLoopRemediationSteps returns steps for validate-milestone", () => {
  const base = makeTmpBase();
  try {
    const result = buildLoopRemediationSteps("validate-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result!.includes("VALIDATION"));
    assert.ok(result!.includes("verdict: pass"));
    assert.ok(result!.includes("gsd recover"));
  } finally {
    cleanup(base);
  }
});
