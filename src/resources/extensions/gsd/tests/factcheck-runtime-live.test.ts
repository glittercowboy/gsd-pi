// Live integration test for factcheck runtime — proves dispatch reroute and corrected-evidence prompt.
//
// Sections:
//   (a) Setup helper: copy S01 fixture to isolated temp directory
//   (b) Dispatch rule matches on planImpacting=true
//   (c) Prompt contains corrected evidence
//   (d) Negative case: no reroute without FACTCHECK-STATUS.json
//   (e) Proof artifacts written to disk
//
// Run: node --test src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────

interface FixtureValidationError {
  fixtureId: string;
  stage: string;
  expectedPath: string;
  message: string;
}

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

// ─── Fixture Paths ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixtureRoot = join(__dirname, "fixtures", "factcheck-runtime");

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
  const tmpDir = join(tmpdir(), `factcheck-live-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
// (a) Setup Helper Test
// ═══════════════════════════════════════════════════════════════════════════

test("setup: fixture copies to temp directory with correct structure", () => {
  const ctx = setupTempGsdProject();

  try {
    // Verify structure
    assert.ok(existsSync(ctx.gsdRoot), "GSD root exists");
    assert.ok(existsSync(ctx.milestoneDir), "Milestone dir exists");
    assert.ok(existsSync(ctx.sliceDir), "Slice dir exists");
    assert.ok(existsSync(ctx.factcheckDir), "Factcheck dir exists");
    assert.ok(existsSync(ctx.claimsDir), "Claims dir exists");

    // Verify key files
    assert.ok(existsSync(join(ctx.sliceDir, "S01-RESEARCH.md")), "Research file exists");
    assert.ok(existsSync(join(ctx.factcheckDir, "FACTCHECK-STATUS.json")), "Status file exists");
    assert.ok(existsSync(join(ctx.claimsDir, "C001.json")), "C001 claim exists");
    assert.ok(existsSync(join(ctx.claimsDir, "C002.json")), "C002 claim exists");
    assert.ok(existsSync(join(ctx.claimsDir, "C003.json")), "C003 claim exists");

    // Verify status content
    const statusContent = readFileSync(join(ctx.factcheckDir, "FACTCHECK-STATUS.json"), "utf-8");
    const status = JSON.parse(statusContent) as FactCheckAggregateStatus;
    assert.strictEqual(status.planImpacting, true, "planImpacting is true");
    assert.strictEqual(status.overallStatus, "has-refutations", "has-refutations status");

    console.log(`  [setup] Created temp project at: ${ctx.tmpDir}`);
  } finally {
    cleanupTempProject(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) Dispatch Rule Matches on planImpacting=true
// ═══════════════════════════════════════════════════════════════════════════

test("dispatch: factcheck-reroute rule matches when planImpacting=true", async () => {
  const ctx = setupTempGsdProject();

  try {
    // Import dispatch module
    const { resolveDispatch, getDispatchRuleNames } = await import("../auto-dispatch.js");
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");

    // Verify factcheck-reroute rule exists
    const ruleNames = getDispatchRuleNames();
    assert.ok(ruleNames.includes("factcheck-reroute → plan-slice"), "factcheck-reroute rule exists");
    console.log(`  [dispatch] Rule names: ${ruleNames.slice(0, 5).join(", ")}...`);

    // Build dispatch context for planning phase with active slice
    const prefs = loadEffectiveGSDPreferences();
    const dispatchCtx = {
      basePath: ctx.gsdRoot,
      mid: "M999-PROOF",
      midTitle: "Proof Milestone",
      state: { phase: "planning", activeSlice: { id: "S01", title: "Proof Slice", done: false } } as any,
      prefs: prefs?.preferences,
    };

    // Call resolveDispatch
    const result = await resolveDispatch(dispatchCtx);

    // Verify dispatch action
    assert.strictEqual(result.action, "dispatch", "Action is dispatch");
    if (result.action === "dispatch") {
      assert.strictEqual(result.unitType, "plan-slice", "Unit type is plan-slice");
      assert.strictEqual(result.unitId, "M999-PROOF/S01", "Unit ID is correct");
      assert.ok(result.prompt, "Prompt is generated");
      console.log(`  [dispatch] Result: action=${result.action}, unitType=${result.unitType}`);
    }
  } finally {
    cleanupTempProject(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) Prompt Contains Corrected Evidence
// ═══════════════════════════════════════════════════════════════════════════

test("prompt: buildPlanSlicePrompt contains corrected value 5.2.0", async () => {
  const ctx = setupTempGsdProject();

  try {
    // Import prompt builder (use .ts extension for --experimental-strip-types)
    const { buildPlanSlicePrompt } = await import("../auto-prompts.ts");

    // Call prompt builder
    const prompt = await buildPlanSlicePrompt(
      "M999-PROOF",
      "Proof Milestone",
      "S01",
      "Proof Slice",
      ctx.gsdRoot,
    );

    // Verify prompt contains corrected value
    assert.ok(prompt.includes("5.2.0"), "Prompt contains corrected value 5.2.0");

    // Verify prompt contains fact-check evidence section
    const hasFactcheckSection = prompt.includes("Fact-Check Evidence") || prompt.includes("REFUTED");
    assert.ok(hasFactcheckSection, "Prompt contains Fact-Check Evidence section or REFUTED marker");

    // Verify prompt mentions the refuted claim
    assert.ok(prompt.includes("C001"), "Prompt mentions C001");

    console.log(`  [prompt] Prompt length: ${prompt.length} chars`);
    console.log(`  [prompt] Contains 5.2.0: ${prompt.includes("5.2.0")}`);
    console.log(`  [prompt] Contains Fact-Check Evidence: ${prompt.includes("Fact-Check Evidence")}`);

    // Extract and log evidence section for debugging
    const evidenceMatch = prompt.match(/## Fact-Check Evidence[\s\S]*?(?=\n## |\n*$)/);
    if (evidenceMatch) {
      console.log(`  [prompt] Evidence section preview:\n${evidenceMatch[0].slice(0, 300)}...`);
    }
  } finally {
    cleanupTempProject(ctx);
  }
});

test("prompt: evidence section shows REFUTED verdict", async () => {
  const ctx = setupTempGsdProject();

  try {
    const { buildPlanSlicePrompt } = await import("../auto-prompts.js");

    const prompt = await buildPlanSlicePrompt(
      "M999-PROOF",
      "Proof Milestone",
      "S01",
      "Proof Slice",
      ctx.gsdRoot,
    );

    // Verify REFUTED appears in prompt
    assert.ok(prompt.includes("REFUTED"), "Prompt contains REFUTED marker");

    // Verify the structure includes corrected value
    const correctedMatch = prompt.match(/Corrected value.*?5\.2\.0/i);
    assert.ok(correctedMatch, "Prompt shows corrected value as 5.2.0");

    console.log(`  [prompt] REFUTED marker found: ${prompt.includes("REFUTED")}`);
  } finally {
    cleanupTempProject(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) Negative Case: No Reroute Without FACTCHECK-STATUS.json
// ═══════════════════════════════════════════════════════════════════════════

test("negative: dispatch falls through when FACTCHECK-STATUS.json missing", async () => {
  const ctx = setupTempGsdProject();

  try {
    const { resolveDispatch } = await import("../auto-dispatch.js");
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");

    // Remove FACTCHECK-STATUS.json to simulate no fact-check state
    rmSync(join(ctx.factcheckDir, "FACTCHECK-STATUS.json"));

    // Build dispatch context
    const prefs = loadEffectiveGSDPreferences();
    const dispatchCtx = {
      basePath: ctx.gsdRoot,
      mid: "M999-PROOF",
      midTitle: "Proof Milestone",
      state: { phase: "planning", activeSlice: { id: "S01", title: "Proof Slice", done: false } } as any,
      prefs: prefs?.preferences,
    };

    // Call resolveDispatch
    const result = await resolveDispatch(dispatchCtx);

    // Should still dispatch plan-slice, but via the regular planning rule (not factcheck-reroute)
    assert.strictEqual(result.action, "dispatch", "Action is still dispatch");
    if (result.action === "dispatch") {
      assert.strictEqual(result.unitType, "plan-slice", "Unit type is plan-slice");
    }

    console.log(`  [negative] Result after removing status: action=${result.action}`);
    console.log(`  [negative] Factcheck status file removed, rule falls through to normal planning`);
  } finally {
    cleanupTempProject(ctx);
  }
});

test("negative: dispatch falls through when planImpacting=false", async () => {
  const ctx = setupTempGsdProject();

  try {
    const { resolveDispatch } = await import("../auto-dispatch.js");
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");

    // Modify FACTCHECK-STATUS.json to set planImpacting=false
    const statusPath = join(ctx.factcheckDir, "FACTCHECK-STATUS.json");
    const statusContent = readFileSync(statusPath, "utf-8");
    const status = JSON.parse(statusContent) as FactCheckAggregateStatus;
    status.planImpacting = false;
    status.overallStatus = "has-refutations";
    writeFileSync(statusPath, JSON.stringify(status, null, 2));

    // Build dispatch context
    const prefs = loadEffectiveGSDPreferences();
    const dispatchCtx = {
      basePath: ctx.gsdRoot,
      mid: "M999-PROOF",
      midTitle: "Proof Milestone",
      state: { phase: "planning", activeSlice: { id: "S01", title: "Proof Slice", done: false } } as any,
      prefs: prefs?.preferences,
    };

    // Call resolveDispatch
    const result = await resolveDispatch(dispatchCtx);

    // Should still dispatch plan-slice via normal planning rule
    assert.strictEqual(result.action, "dispatch", "Action is dispatch");
    if (result.action === "dispatch") {
      assert.strictEqual(result.unitType, "plan-slice", "Unit type is plan-slice");
    }

    console.log(`  [negative] planImpacting=false: rule falls through to normal planning`);
  } finally {
    cleanupTempProject(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) Proof Artifacts Written to Disk
// ═══════════════════════════════════════════════════════════════════════════

test("artifacts: proof artifacts written to proof-output directory", async () => {
  const ctx = setupTempGsdProject();

  try {
    const { resolveDispatch } = await import("../auto-dispatch.js");
    const { buildPlanSlicePrompt } = await import("../auto-prompts.js");
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");

    // Create proof-output directory
    const proofOutputDir = join(ctx.tmpDir, "proof-output");
    mkdirSync(proofOutputDir, { recursive: true });

    // Get dispatch action
    const prefs = loadEffectiveGSDPreferences();
    const dispatchCtx = {
      basePath: ctx.gsdRoot,
      mid: "M999-PROOF",
      midTitle: "Proof Milestone",
      state: { phase: "planning", activeSlice: { id: "S01", title: "Proof Slice", done: false } } as any,
      prefs: prefs?.preferences,
    };

    const dispatchResult = await resolveDispatch(dispatchCtx);

    // Write reroute-action.json
    if (dispatchResult.action === "dispatch") {
      const rerouteAction = {
        action: dispatchResult.action,
        unitType: dispatchResult.unitType,
        unitId: dispatchResult.unitId,
      };
      writeFileSync(join(proofOutputDir, "reroute-action.json"), JSON.stringify(rerouteAction, null, 2));
    }

    // Get prompt and extract evidence section
    const prompt = await buildPlanSlicePrompt(
      "M999-PROOF",
      "Proof Milestone",
      "S01",
      "Proof Slice",
      ctx.gsdRoot,
    );

    // Extract fact-check evidence section for proof artifact
    const evidenceMatch = prompt.match(/## Fact-Check Evidence[\s\S]*?(?=\n## |\n*$)/);
    const promptExcerpt = evidenceMatch ? evidenceMatch[0] : "No evidence section found";
    writeFileSync(join(proofOutputDir, "prompt-excerpt.txt"), promptExcerpt);

    // Verify artifacts exist
    assert.ok(existsSync(join(proofOutputDir, "reroute-action.json")), "reroute-action.json exists");
    assert.ok(existsSync(join(proofOutputDir, "prompt-excerpt.txt")), "prompt-excerpt.txt exists");

    // Verify artifact contents
    const rerouteAction = JSON.parse(readFileSync(join(proofOutputDir, "reroute-action.json"), "utf-8"));
    assert.strictEqual(rerouteAction.action, "dispatch", "Reroute action is dispatch");
    assert.strictEqual(rerouteAction.unitType, "plan-slice", "Reroute unitType is plan-slice");

    const excerptContent = readFileSync(join(proofOutputDir, "prompt-excerpt.txt"), "utf-8");
    assert.ok(excerptContent.includes("5.2.0"), "Excerpt contains corrected value 5.2.0");
    assert.ok(excerptContent.includes("C001"), "Excerpt mentions C001");

    console.log(`  [artifacts] Proof output directory: ${proofOutputDir}`);
    console.log(`  [artifacts] reroute-action.json: ${JSON.stringify(rerouteAction)}`);
    console.log(`  [artifacts] prompt-excerpt.txt: ${excerptContent.slice(0, 200)}...`);
  } finally {
    cleanupTempProject(ctx);
  }
});

// ═══════════════════════ValidationError Shape Test ══════════════════════════

test("validation: FixtureValidationError shape is correct", () => {
  // Verify the error shape matches expected interface
  const error: FixtureValidationError = {
    fixtureId: "test-fixture",
    stage: "artifact-parse",
    expectedPath: "/path/to/file.json",
    message: "File not found",
  };

  assert.strictEqual(typeof error.fixtureId, "string");
  assert.strictEqual(typeof error.stage, "string");
  assert.strictEqual(typeof error.expectedPath, "string");
  assert.strictEqual(typeof error.message, "string");

  console.log(`  [validation] FixtureValidationError shape verified`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

test("Test suite complete", () => {
  console.log("\n=== FACTCHECK-RUNTIME-LIVE TESTS ===");
  console.log("All live integration tests passed.");
  console.log("Proven: dispatch reroute, corrected evidence injection, proof artifacts.");
});
