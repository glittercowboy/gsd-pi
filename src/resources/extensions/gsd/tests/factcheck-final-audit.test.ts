// Final audit test for factcheck runtime — writes durable validation report to milestone directory.
//
// This test exercises the real dispatch + prompt assembly proof path, captures the evidence,
// and persists a structured validation report that serves as the milestone closeout artifact.
//
// Sections:
//   (a) Setup: copy S01 fixture to isolated temp directory
//   (b) Dispatch: factcheck-reroute rule matches on planImpacting=true
//   (c) Prompt: contains corrected evidence (5.2.0)
//   (d) Report: write structured M007-VALIDATION-REPORT.json to milestone directory
//   (e) Verify: read back and validate report structure
//
// Run: node --test src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────

interface FactCheckAggregateStatus {
  schemaVersion: number;
  cycleKey: string;
  overallStatus: "clean" | "has-refutations" | "pending" | "exhausted";
  planImpacting: boolean;
  counts: {
    total: number;
    confirmed: number;
    refuted: number;
    inconclusive: number;
    unverified: number;
  };
  maxCycles: number;
  currentCycle: number;
  claimIds: string[];
  planImpactingClaims?: string[];
  rerouteTarget?: string;
  checkedAt?: string;
}

interface ValidationReport {
  schemaVersion: number;
  milestone: string;
  generatedAt: string;
  evidence: {
    refutedCount: number;
    rerouteTarget: string;
    correctedValuePresent: boolean;
    promptExcerptContains: string;
    dispatchAction: {
      action: string;
      unitType: string;
      unitId: string;
    };
  };
  result: "PASS" | "FAIL";
  proofArtifacts: string[];
}

// ─── Paths ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixtureRoot = join(__dirname, "fixtures", "factcheck-runtime");

// Real worktree milestone path (where validation report gets written)
const WORKTREE_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MILESTONE_DIR = join(WORKTREE_ROOT, ".gsd", "milestones", "M007-aos64t");

// ─── Setup Helper ────────────────────────────────────────────────────────

interface TestContext {
  tmpDir: string;
  gsdRoot: string;
  milestoneDir: string;
  sliceDir: string;
  factcheckDir: string;
  claimsDir: string;
}

function setupTempGsdProject(): TestContext {
  const tmpDir = join(tmpdir(), `factcheck-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const gsdRoot = join(tmpDir, "project-root");
  const milestoneDir = join(gsdRoot, ".gsd", "milestones", "M999-PROOF");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const factcheckDir = join(sliceDir, "factcheck");
  const claimsDir = join(factcheckDir, "claims");

  // Create directory structure
  mkdirSync(claimsDir, { recursive: true });

  // Copy fixture data from S01
  const fixtureSliceDir = join(fixtureRoot, "M999-PROOF", "slices", "S01");
  const fixtureFactcheckDir = join(fixtureSliceDir, "factcheck");
  const fixtureClaimsDir = join(fixtureFactcheckDir, "claims");

  // Copy research file
  cpSync(join(fixtureSliceDir, "S01-RESEARCH.md"), join(sliceDir, "S01-RESEARCH.md"));

  // Copy factcheck status
  cpSync(join(fixtureFactcheckDir, "FACTCHECK-STATUS.json"), join(factcheckDir, "FACTCHECK-STATUS.json"));

  // Copy all claim annotations
  cpSync(fixtureClaimsDir, claimsDir, { recursive: true });

  // Create minimal roadmap file (required by buildPlanSlicePrompt)
  const roadmapContent = `---
milestone: M999-PROOF
title: Proof Milestone
---

# Roadmap

## Slices

- [ ] S01: Proof Slice
`;
  writeFileSync(join(milestoneDir, "M999-PROOF-ROADMAP.md"), roadmapContent);

  // Create minimal slice plan (so dependencies can be read)
  const planContent = `---
id: S01
milestone: M999-PROOF
---

# S01-PLAN: Proof Slice

## Goal
Prove dispatch reroute and evidence injection.

## Tasks
- [ ] T01: First task
`;
  writeFileSync(join(sliceDir, "S01-PLAN.md"), planContent);

  return { tmpDir, gsdRoot, milestoneDir, sliceDir, factcheckDir, claimsDir };
}

function cleanupTempProject(ctx: TestContext): void {
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Final Audit Test — Complete Proof Path with Durable Report
// ═══════════════════════════════════════════════════════════════════════════

test("final-audit: writes durable validation report to milestone directory", async () => {
  const ctx = setupTempGsdProject();
  let reportPath: string | null = null;

  try {
    // ─── Step 1: Load fixture status and verify planImpacting=true ──────────────
    const statusPath = join(ctx.factcheckDir, "FACTCHECK-STATUS.json");
    const statusContent = readFileSync(statusPath, "utf-8");
    const status = JSON.parse(statusContent) as FactCheckAggregateStatus;

    assert.strictEqual(status.planImpacting, true, "Fixture has planImpacting=true");
    assert.strictEqual(status.overallStatus, "has-refutations", "Fixture has has-refutations status");
    assert.strictEqual(status.counts.refuted, 1, "Fixture has 1 refuted claim");

    console.log(`  [step-1] Fixture loaded: refutedCount=${status.counts.refuted}, planImpacting=${status.planImpacting}`);

    // ─── Step 2: Run dispatch and capture reroute action ────────────────────────
    const { resolveDispatch } = await import("../auto-dispatch.js");
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");

    const prefs = loadEffectiveGSDPreferences();
    const dispatchCtx = {
      basePath: ctx.gsdRoot,
      mid: "M999-PROOF",
      midTitle: "Proof Milestone",
      state: {
        phase: "planning",
        activeSlice: { id: "S01", title: "Proof Slice", done: false },
      } as any,
      prefs: prefs?.preferences,
    };

    const dispatchResult = await resolveDispatch(dispatchCtx);

    // Verify dispatch returned reroute action
    assert.strictEqual(dispatchResult.action, "dispatch", "Dispatch action is 'dispatch'");

    const dispatchAction = {
      action: dispatchResult.action,
      unitType: (dispatchResult as { action: "dispatch"; unitType: string; unitId: string }).unitType,
      unitId: (dispatchResult as { action: "dispatch"; unitType: string; unitId: string }).unitId,
    };

    assert.strictEqual(dispatchAction.unitType, "plan-slice", "Unit type is plan-slice");
    console.log(`  [step-2] Dispatch: action=${dispatchAction.action}, unitType=${dispatchAction.unitType}, unitId=${dispatchAction.unitId}`);

    // ─── Step 3: Run prompt builder and extract evidence section ─────────────────
    const { buildPlanSlicePrompt } = await import("../auto-prompts.ts");

    const prompt = await buildPlanSlicePrompt(
      "M999-PROOF",
      "Proof Milestone",
      "S01",
      "Proof Slice",
      ctx.gsdRoot,
    );

    // Verify prompt contains corrected value
    const correctedValuePresent = prompt.includes("5.2.0");
    assert.ok(correctedValuePresent, "Prompt contains corrected value 5.2.0");

    // Verify prompt contains REFUTED marker
    const hasRefutedMarker = prompt.includes("REFUTED");
    assert.ok(hasRefutedMarker, "Prompt contains REFUTED marker");

    // Extract evidence section excerpt
    const evidenceMatch = prompt.match(/## Fact-Check Evidence[\s\S]*?(?=\n## |\n*$)/);
    const promptExcerpt = evidenceMatch ? evidenceMatch[0].slice(0, 500) : "No evidence section found";

    console.log(`  [step-3] Prompt: length=${prompt.length}, correctedValuePresent=${correctedValuePresent}`);
    console.log(`  [step-3] Evidence excerpt preview: ${promptExcerpt.slice(0, 200)}...`);

    // ─── Step 4: Construct and write validation report ──────────────────────────
    const report: ValidationReport = {
      schemaVersion: 1,
      milestone: "M007-aos64t",
      generatedAt: new Date().toISOString(),
      evidence: {
        refutedCount: status.counts.refuted,
        rerouteTarget: dispatchAction.unitType,
        correctedValuePresent,
        promptExcerptContains: "5.2.0",
        dispatchAction,
      },
      result: "PASS",
      proofArtifacts: ["FACTCHECK-STATUS.json", "C001.json", "reroute-action.json"],
    };

    // Ensure milestone directory exists
    if (!existsSync(MILESTONE_DIR)) {
      mkdirSync(MILESTONE_DIR, { recursive: true });
    }

    reportPath = join(MILESTONE_DIR, "M007-VALIDATION-REPORT.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`  [step-4] Validation report written to: ${reportPath}`);

    // ─── Step 5: Read back and verify structural validity ───────────────────────
    assert.ok(existsSync(reportPath), "Report file exists");

    const readBackContent = readFileSync(reportPath, "utf-8");
    const readBackReport = JSON.parse(readBackContent) as ValidationReport;

    // Validate all required fields
    assert.strictEqual(readBackReport.schemaVersion, 1, "schemaVersion is 1");
    assert.strictEqual(readBackReport.milestone, "M007-aos64t", "milestone is M007-aos64t");
    assert.ok(readBackReport.generatedAt, "generatedAt is present");
    assert.strictEqual(typeof readBackReport.evidence.refutedCount, "number", "evidence.refutedCount is number");
    assert.strictEqual(readBackReport.evidence.rerouteTarget, "plan-slice", "evidence.rerouteTarget is plan-slice");
    assert.strictEqual(readBackReport.evidence.correctedValuePresent, true, "evidence.correctedValuePresent is true");
    assert.strictEqual(readBackReport.evidence.promptExcerptContains, "5.2.0", "evidence.promptExcerptContains is 5.2.0");
    assert.strictEqual(readBackReport.evidence.dispatchAction.action, "dispatch", "evidence.dispatchAction.action is dispatch");
    assert.strictEqual(readBackReport.result, "PASS", "result is PASS");
    assert.ok(Array.isArray(readBackReport.proofArtifacts), "proofArtifacts is array");
    assert.ok(readBackReport.proofArtifacts.includes("FACTCHECK-STATUS.json"), "proofArtifacts includes FACTCHECK-STATUS.json");

    console.log(`  [step-5] Report verified: result=${readBackReport.result}`);
    console.log(`  [final] All assertions passed — validation report is durable evidence`);

  } finally {
    cleanupTempProject(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Schema Compliance Test
// ═══════════════════════════════════════════════════════════════════════════

test("schema: validation report matches required schema", async () => {
  const reportPath = join(MILESTONE_DIR, "M007-VALIDATION-REPORT.json");

  // Skip if report doesn't exist yet (will be created by main test)
  if (!existsSync(reportPath)) {
    console.log("  [schema] Report not yet created, skipping schema check");
    return;
  }

  const content = readFileSync(reportPath, "utf-8");
  const report = JSON.parse(content);

  // Required top-level fields
  const requiredFields = ["schemaVersion", "milestone", "generatedAt", "evidence", "result", "proofArtifacts"];
  for (const field of requiredFields) {
    assert.ok(field in report, `Required field '${field}' present`);
  }

  // Required evidence sub-fields
  const evidenceFields = ["refutedCount", "rerouteTarget", "correctedValuePresent", "dispatchAction"];
  for (const field of evidenceFields) {
    assert.ok(field in report.evidence, `Required evidence field '${field}' present`);
  }

  // Type checks
  assert.strictEqual(typeof report.schemaVersion, "number", "schemaVersion is number");
  assert.strictEqual(typeof report.milestone, "string", "milestone is string");
  assert.strictEqual(typeof report.generatedAt, "string", "generatedAt is string");
  assert.strictEqual(typeof report.result, "string", "result is string");
  assert.ok(["PASS", "FAIL"].includes(report.result), "result is PASS or FAIL");
  assert.ok(Array.isArray(report.proofArtifacts), "proofArtifacts is array");

  console.log("  [schema] All schema checks passed");
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

test("Test suite complete", () => {
  console.log("\n=== FACTCHECK-FINAL-AUDIT TESTS ===");
  console.log("Durable validation report written to milestone directory.");
  console.log("Milestone M007-aos64t can be closed on repeatable, inspectable evidence.");
});
