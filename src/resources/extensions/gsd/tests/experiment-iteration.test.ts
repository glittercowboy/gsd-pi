/**
 * Tests for GSD Experiment Runner — Fidelity Scoring and Bounded Iteration
 *
 * Covers:
 * - FidelityRubric validation (valid, out-of-range, non-integer)
 * - Scoring capture and persistence into comparison reports
 * - Bounded iteration runner (max 3 iterations)
 * - Convergence conclusion artifact
 *
 * @module experiment-iteration.test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateRubric,
  isValidRubric,
  captureScoring,
  readScoring,
  averageScore,
  compareRubrics,
  FidelityRubricError,
  type FidelityRubric,
  type ScoringSlot,
  computeDelta,
  runExperimentLoop,
  readConclusion,
  validateConclusion,
  MAX_ITERATIONS,
  DEFAULT_CONVERGENCE_THRESHOLD,
  type ExperimentConclusion,
} from "../experiment-runner.js";
import type { CompareReport } from "../compare-runner.js";
import { runComparison, writeComparisonReport } from "../compare-runner.js";

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const TEMP_DIR = join(import.meta.dirname, ".tmp-experiment-test");

function setupTempDir(): void {
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
  mkdirSync(TEMP_DIR, { recursive: true });
}

function teardownTempDir(): void {
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
}

function createMinimalReport(outputDir: string): string {
  const report: CompareReport = {
    metadata: {
      fixtureId: "test-fixture",
      model: "test-model",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    },
    baseline: {
      config: { features: { unknownsInventory: false, factCheckCoordination: false } },
      metrics: {
        wallClockMs: 100,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.001,
        interventions: { blocker: 0, correction: 0, redirect: 0 },
        factCheck: null,
      },
    },
    treatment: {
      config: { features: { unknownsInventory: true, factCheckCoordination: true } },
      metrics: {
        wallClockMs: 150,
        tokens: { input: 130, output: 65, cacheRead: 0, cacheWrite: 0, total: 195 },
        cost: 0.0015,
        interventions: { blocker: 0, correction: 0, redirect: 0 },
        factCheck: { claimsChecked: 3, verified: 2, refuted: 0, inconclusive: 1, scoutTokens: 100 },
      },
    },
    scoring: {},
  };

  const reportPath = join(outputDir, "COMPARE-REPORT.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  return reportPath;
}

function validRubric(): FidelityRubric {
  return {
    factualAccuracy: 4,
    completeness: 5,
    coherence: 3,
    conciseness: 4,
    notes: "Good overall, minor clarity issues",
  };
}

// ─── Rubric Validation Tests ───────────────────────────────────────────────────

describe("validateRubric", () => {
  it("accepts valid rubric with all dimensions in range 1-5", () => {
    const rubric = validRubric();
    assert.doesNotThrow(() => validateRubric(rubric));
  });

  it("accepts rubric without optional notes", () => {
    const rubric: FidelityRubric = {
      factualAccuracy: 3,
      completeness: 3,
      coherence: 3,
      conciseness: 3,
    };
    assert.doesNotThrow(() => validateRubric(rubric));
  });

  it("rejects rubric with score 0 (below minimum)", () => {
    const rubric = { ...validRubric(), factualAccuracy: 0 };
    assert.throws(
      () => validateRubric(rubric),
      (err) => {
        assert(err instanceof FidelityRubricError);
        assert(err.message.includes("factualAccuracy"));
        assert(err.message.includes("range 1-5"));
        return true;
      },
    );
  });

  it("rejects rubric with score 6 (above maximum)", () => {
    const rubric = { ...validRubric(), completeness: 6 };
    assert.throws(
      () => validateRubric(rubric),
      (err) => {
        assert(err instanceof FidelityRubricError);
        assert(err.message.includes("completeness"));
        assert(err.message.includes("range 1-5"));
        return true;
      },
    );
  });

  it("rejects rubric with non-integer score", () => {
    const rubric = { ...validRubric(), coherence: 3.5 };
    assert.throws(
      () => validateRubric(rubric),
      (err) => {
        assert(err instanceof FidelityRubricError);
        assert(err.message.includes("coherence"));
        assert(err.message.includes("integer"));
        return true;
      },
    );
  });

  it("rejects rubric with missing dimension", () => {
    const rubric = { factualAccuracy: 3, completeness: 3, coherence: 3 } as FidelityRubric;
    assert.throws(
      () => validateRubric(rubric),
      (err) => {
        assert(err instanceof FidelityRubricError);
        assert(err.message.includes("conciseness"));
        assert(err.message.includes("Missing"));
        return true;
      },
    );
  });

  it("rejects non-object input", () => {
    assert.throws(
      () => validateRubric(null),
      (err) => {
        assert(err instanceof FidelityRubricError);
        assert(err.message.includes("must be an object"));
        return true;
      },
    );

    assert.throws(
      () => validateRubric("not an object"),
      (err) => {
        assert(err instanceof FidelityRubricError);
        return true;
      },
    );
  });

  it("rejects notes that are not strings", () => {
    const rubric = { ...validRubric(), notes: 123 as unknown as string };
    assert.throws(
      () => validateRubric(rubric),
      (err) => {
        assert(err instanceof FidelityRubricError);
        assert(err.message.includes("notes"));
        assert(err.message.includes("string"));
        return true;
      },
    );
  });
});

describe("isValidRubric", () => {
  it("returns true for valid rubric", () => {
    assert.strictEqual(isValidRubric(validRubric()), true);
  });

  it("returns false for invalid rubric", () => {
    assert.strictEqual(isValidRubric({ ...validRubric(), factualAccuracy: 0 }), false);
    assert.strictEqual(isValidRubric(null), false);
    assert.strictEqual(isValidRubric({ factualAccuracy: 3 }), false);
  });
});

// ─── Scoring Capture Tests ──────────────────────────────────────────────────────

describe("captureScoring", () => {
  beforeEach(() => setupTempDir());
  afterEach(() => teardownTempDir());

  it("persists scoring into comparison report for baseline", () => {
    const reportPath = createMinimalReport(TEMP_DIR);
    const rubric = validRubric();

    captureScoring(reportPath, "baseline", rubric);

    const scoring = readScoring(reportPath);
    assert(scoring !== null);
    assert(scoring.baseline !== undefined);
    assert.deepStrictEqual(scoring.baseline, rubric);
    assert(scoring.treatment === undefined);
  });

  it("persists scoring into comparison report for treatment", () => {
    const reportPath = createMinimalReport(TEMP_DIR);
    const rubric = validRubric();

    captureScoring(reportPath, "treatment", rubric);

    const scoring = readScoring(reportPath);
    assert(scoring !== null);
    assert(scoring.treatment !== undefined);
    assert.deepStrictEqual(scoring.treatment, rubric);
    assert(scoring.baseline === undefined);
  });

  it("preserves existing scoring when adding new path", () => {
    const reportPath = createMinimalReport(TEMP_DIR);
    const baselineRubric: FidelityRubric = { factualAccuracy: 3, completeness: 3, coherence: 3, conciseness: 3 };
    const treatmentRubric: FidelityRubric = { factualAccuracy: 4, completeness: 4, coherence: 4, conciseness: 4 };

    captureScoring(reportPath, "baseline", baselineRubric);
    captureScoring(reportPath, "treatment", treatmentRubric);

    const scoring = readScoring(reportPath);
    assert(scoring !== null);
    assert.deepStrictEqual(scoring.baseline, baselineRubric);
    assert.deepStrictEqual(scoring.treatment, treatmentRubric);
  });

  it("throws for missing report file", () => {
    const missingPath = join(TEMP_DIR, "nonexistent", "COMPARE-REPORT.json");
    assert.throws(
      () => captureScoring(missingPath, "baseline", validRubric()),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("not found"));
        return true;
      },
    );
  });

  it("throws for invalid JSON in report file", () => {
    const badJsonPath = join(TEMP_DIR, "COMPARE-REPORT.json");
    writeFileSync(badJsonPath, "{ invalid json", "utf-8");

    assert.throws(
      () => captureScoring(badJsonPath, "baseline", validRubric()),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("Failed to parse"));
        return true;
      },
    );
  });

  it("throws FidelityRubricError for invalid rubric", () => {
    const reportPath = createMinimalReport(TEMP_DIR);
    const invalidRubric = { ...validRubric(), factualAccuracy: 10 };

    assert.throws(
      () => captureScoring(reportPath, "baseline", invalidRubric as FidelityRubric),
      (err) => {
        assert(err instanceof FidelityRubricError);
        return true;
      },
    );
  });
});

// ─── Scoring Helpers Tests ─────────────────────────────────────────────────────

describe("averageScore", () => {
  it("computes correct average across all dimensions", () => {
    const rubric: FidelityRubric = {
      factualAccuracy: 4,
      completeness: 5,
      coherence: 3,
      conciseness: 4,
    };
    // (4 + 5 + 3 + 4) / 4 = 4
    assert.strictEqual(averageScore(rubric), 4);
  });

  it("handles mixed scores", () => {
    const rubric: FidelityRubric = {
      factualAccuracy: 5,
      completeness: 5,
      coherence: 1,
      conciseness: 1,
    };
    // (5 + 5 + 1 + 1) / 4 = 3
    assert.strictEqual(averageScore(rubric), 3);
  });
});

describe("compareRubrics", () => {
  it("returns positive values when treatment is better", () => {
    const baseline: FidelityRubric = {
      factualAccuracy: 3,
      completeness: 3,
      coherence: 3,
      conciseness: 3,
    };
    const treatment: FidelityRubric = {
      factualAccuracy: 4,
      completeness: 5,
      coherence: 4,
      conciseness: 4,
    };

    const diff = compareRubrics(baseline, treatment);
    assert.strictEqual(diff.factualAccuracy, 1);
    assert.strictEqual(diff.completeness, 2);
    assert.strictEqual(diff.coherence, 1);
    assert.strictEqual(diff.conciseness, 1);
  });

  it("returns negative values when baseline is better", () => {
    const baseline: FidelityRubric = {
      factualAccuracy: 5,
      completeness: 5,
      coherence: 5,
      conciseness: 5,
    };
    const treatment: FidelityRubric = {
      factualAccuracy: 3,
      completeness: 4,
      coherence: 2,
      conciseness: 3,
    };

    const diff = compareRubrics(baseline, treatment);
    assert.strictEqual(diff.factualAccuracy, -2);
    assert.strictEqual(diff.completeness, -1);
    assert.strictEqual(diff.coherence, -3);
    assert.strictEqual(diff.conciseness, -2);
  });

  it("returns zeros when rubrics are equal", () => {
    const rubric: FidelityRubric = {
      factualAccuracy: 4,
      completeness: 4,
      coherence: 4,
      conciseness: 4,
    };

    const diff = compareRubrics(rubric, rubric);
    assert.strictEqual(diff.factualAccuracy, 0);
    assert.strictEqual(diff.completeness, 0);
    assert.strictEqual(diff.coherence, 0);
    assert.strictEqual(diff.conciseness, 0);
  });
});

// ─── Read Scoring Tests ────────────────────────────────────────────────────────

describe("readScoring", () => {
  beforeEach(() => setupTempDir());
  afterEach(() => teardownTempDir());

  it("returns null for missing file", () => {
    const missingPath = join(TEMP_DIR, "nonexistent.json");
    assert.strictEqual(readScoring(missingPath), null);
  });

  it("returns null for report without scoring", () => {
    const report: CompareReport = {
      metadata: {
        fixtureId: "test",
        model: "test",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      baseline: {
        config: { features: { unknownsInventory: false, factCheckCoordination: false } },
        metrics: {
          wallClockMs: 100,
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: 0.001,
          interventions: { blocker: 0, correction: 0, redirect: 0 },
          factCheck: null,
        },
      },
      treatment: {
        config: { features: { unknownsInventory: true, factCheckCoordination: true } },
        metrics: {
          wallClockMs: 150,
          tokens: { input: 130, output: 65, cacheRead: 0, cacheWrite: 0, total: 195 },
          cost: 0.0015,
          interventions: { blocker: 0, correction: 0, redirect: 0 },
          factCheck: null,
        },
      },
      scoring: {},
    };

    const reportPath = join(TEMP_DIR, "COMPARE-REPORT.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

    const scoring = readScoring(reportPath);
    // Empty scoring object should return as-is (with baseline/treatment undefined)
    assert(scoring !== null);
    assert.strictEqual(scoring.baseline, undefined);
    assert.strictEqual(scoring.treatment, undefined);
  });

  it("returns scoring with populated rubrics", () => {
    const reportPath = createMinimalReport(TEMP_DIR);
    const baselineRubric: FidelityRubric = { factualAccuracy: 3, completeness: 4, coherence: 3, conciseness: 4 };
    const treatmentRubric: FidelityRubric = { factualAccuracy: 4, completeness: 5, coherence: 4, conciseness: 5 };

    captureScoring(reportPath, "baseline", baselineRubric);
    captureScoring(reportPath, "treatment", treatmentRubric);

    const scoring = readScoring(reportPath);
    assert(scoring !== null);
    assert.deepStrictEqual(scoring.baseline, baselineRubric);
    assert.deepStrictEqual(scoring.treatment, treatmentRubric);
  });
});

// ─── Delta Computation Tests ───────────────────────────────────────────────────

describe("computeDelta", () => {
  function createReport(overrides?: {
    baselineTokens?: { input: number; output: number };
    treatmentTokens?: { input: number; output: number };
    baselineCost?: number;
    treatmentCost?: number;
    treatmentFactCheck?: { claimsChecked: number; verified: number; refuted: number; inconclusive: number; scoutTokens: number } | null;
  }): CompareReport {
    const baselineTokens = overrides?.baselineTokens ?? { input: 100, output: 50 };
    const treatmentTokens = overrides?.treatmentTokens ?? { input: 130, output: 65 };
    
    return {
      metadata: {
        fixtureId: "test-fixture",
        model: "test-model",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      baseline: {
        config: { features: { unknownsInventory: false, factCheckCoordination: false } },
        metrics: {
          wallClockMs: 100,
          tokens: { 
            input: baselineTokens.input, 
            output: baselineTokens.output, 
            cacheRead: 0, 
            cacheWrite: 0, 
            total: baselineTokens.input + baselineTokens.output 
          },
          cost: overrides?.baselineCost ?? 0.001,
          interventions: { blocker: 0, correction: 0, redirect: 0 },
          factCheck: null,
        },
      },
      treatment: {
        config: { features: { unknownsInventory: true, factCheckCoordination: true } },
        metrics: {
          wallClockMs: 150,
          tokens: { 
            input: treatmentTokens.input, 
            output: treatmentTokens.output, 
            cacheRead: 0, 
            cacheWrite: 0, 
            total: treatmentTokens.input + treatmentTokens.output 
          },
          cost: overrides?.treatmentCost ?? 0.0015,
          interventions: { blocker: 0, correction: 0, redirect: 0 },
          factCheck: overrides?.treatmentFactCheck ?? { claimsChecked: 3, verified: 2, refuted: 0, inconclusive: 1, scoutTokens: 100 },
        },
      },
      scoring: {},
    };
  }

  it("computes token deltas correctly", () => {
    const prevReport = createReport({ baselineTokens: { input: 100, output: 50 } });
    const currReport = createReport({ baselineTokens: { input: 120, output: 60 } });

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.tokensBaselineInput, 20);
    assert.strictEqual(delta.tokensBaselineOutput, 10);
    assert.strictEqual(delta.tokensBaselineTotal, 30);
  });

  it("computes treatment token deltas correctly", () => {
    const prevReport = createReport({ treatmentTokens: { input: 130, output: 65 } });
    const currReport = createReport({ treatmentTokens: { input: 150, output: 75 } });

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.tokensTreatmentInput, 20);
    assert.strictEqual(delta.tokensTreatmentOutput, 10);
    assert.strictEqual(delta.tokensTreatmentTotal, 30);
  });

  it("computes cost deltas correctly", () => {
    const prevReport = createReport({ baselineCost: 0.001, treatmentCost: 0.0015 });
    const currReport = createReport({ baselineCost: 0.002, treatmentCost: 0.003 });

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.costBaseline, 0.001);
    assert.strictEqual(delta.costTreatment, 0.0015);
  });

  it("computes fact-check deltas when both reports have fact-check data", () => {
    const prevReport = createReport({ 
      treatmentFactCheck: { claimsChecked: 3, verified: 2, refuted: 0, inconclusive: 1, scoutTokens: 100 } 
    });
    const currReport = createReport({ 
      treatmentFactCheck: { claimsChecked: 5, verified: 4, refuted: 1, inconclusive: 0, scoutTokens: 100 } 
    });

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.factCheckClaims, 2);
    assert.strictEqual(delta.factCheckVerified, 2);
    assert.strictEqual(delta.factCheckRefuted, 1);
    assert.strictEqual(delta.factCheckInconclusive, -1);
  });

  it("omits fact-check deltas when fact-check is null", () => {
    const prevReport = createReport({ treatmentFactCheck: null });
    // Need to explicitly set factCheck to null since the helper has a default
    prevReport.treatment.metrics.factCheck = null;
    const currReport = createReport({ treatmentFactCheck: null });
    currReport.treatment.metrics.factCheck = null;

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.factCheckClaims, undefined);
    assert.strictEqual(delta.factCheckVerified, undefined);
  });

  it("omits fidelity deltas when scoring not captured", () => {
    const prevReport = createReport();
    const currReport = createReport();

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.fidelityBaseline, undefined);
    assert.strictEqual(delta.fidelityTreatment, undefined);
  });

  it("computes fidelity deltas when scoring is present", () => {
    const prevReport = createReport();
    prevReport.scoring = {
      baseline: { factualAccuracy: 3, completeness: 3, coherence: 3, conciseness: 3 },
      treatment: { factualAccuracy: 4, completeness: 4, coherence: 4, conciseness: 4 },
    };

    const currReport = createReport();
    currReport.scoring = {
      baseline: { factualAccuracy: 4, completeness: 4, coherence: 4, conciseness: 4 },
      treatment: { factualAccuracy: 5, completeness: 5, coherence: 5, conciseness: 5 },
    };

    const delta = computeDelta(prevReport, currReport);

    assert.strictEqual(delta.fidelityBaseline, 1); // 4 - 3 = 1
    assert.strictEqual(delta.fidelityTreatment, 1); // 5 - 4 = 1
  });

  it("returns zero deltas for identical reports", () => {
    const report = createReport();

    const delta = computeDelta(report, report);

    assert.strictEqual(delta.tokensBaselineInput, 0);
    assert.strictEqual(delta.tokensBaselineOutput, 0);
    assert.strictEqual(delta.tokensTreatmentInput, 0);
    assert.strictEqual(delta.tokensTreatmentOutput, 0);
    assert.strictEqual(delta.costBaseline, 0);
    assert.strictEqual(delta.costTreatment, 0);
  });
});

// ─── Bounded Iteration Runner Tests ────────────────────────────────────────────

describe("runExperimentLoop", () => {
  beforeEach(() => setupTempDir());
  afterEach(() => teardownTempDir());

  it("produces conclusion with iterationCount: 1 for single iteration", () => {
    const outputDir = join(TEMP_DIR, "single-iteration");
    const conclusion = runExperimentLoop("low-unknown", outputDir, ["initial run"]);

    assert.strictEqual(conclusion.status, "non-converged");
    assert.strictEqual(conclusion.iterationCount, 1);
    assert.strictEqual(conclusion.iterationLog.length, 1);
    assert.strictEqual(conclusion.iterationLog[0].iteration, 1);
    assert.strictEqual(conclusion.iterationLog[0].change, "initial run");
    // First iteration has no previous, so deltaSummary should be empty
    assert.strictEqual(Object.keys(conclusion.iterationLog[0].deltaSummary).length, 0);
    assert.ok(conclusion.finalReportPath.includes("iteration-1"));
    assert.ok(conclusion.concludedAt);
  });

  it("refuses 4th iteration with bounded status", () => {
    const outputDir = join(TEMP_DIR, "bounded-test");
    const changes = ["change 1", "change 2", "change 3", "change 4"];

    const conclusion = runExperimentLoop("low-unknown", outputDir, changes);

    assert.strictEqual(conclusion.status, "bounded");
    assert.strictEqual(conclusion.iterationCount, 0); // No iterations executed
    assert.strictEqual(conclusion.iterationLog.length, 0);
    assert.strictEqual(conclusion.finalReportPath, ""); // Empty since no iterations ran
  });

  it("refuses 5th iteration with bounded status", () => {
    const outputDir = join(TEMP_DIR, "bounded-test-5");
    const changes = ["change 1", "change 2", "change 3", "change 4", "change 5"];

    const conclusion = runExperimentLoop("low-unknown", outputDir, changes);

    assert.strictEqual(conclusion.status, "bounded");
    assert.strictEqual(conclusion.iterationCount, 0);
  });

  it("runs 3 iterations and marks bounded when hitting max without prior convergence", () => {
    const outputDir = join(TEMP_DIR, "three-iterations-bounded");
    const changes = ["change 1", "change 2", "change 3"];

    // With threshold 0, zero deltas won't converge (|0| < 0 is false)
    // This forces all 3 iterations to run without early convergence
    const conclusion = runExperimentLoop("low-unknown", outputDir, changes, {
      convergenceThreshold: 0,
    });

    assert.strictEqual(conclusion.iterationCount, 3);
    assert.strictEqual(conclusion.iterationLog.length, 3);
    assert.strictEqual(conclusion.iterationLog[0].change, "change 1");
    assert.strictEqual(conclusion.iterationLog[1].change, "change 2");
    assert.strictEqual(conclusion.iterationLog[2].change, "change 3");
    // Status is "bounded" because we hit the max (3) without convergence
    assert.strictEqual(conclusion.status, "bounded");
  });

  it("converges early when deltas are below threshold", () => {
    const outputDir = join(TEMP_DIR, "early-convergence");
    const changes = ["change 1", "change 2", "change 3"];

    // With default threshold (0.01), zero deltas will converge immediately
    const conclusion = runExperimentLoop("low-unknown", outputDir, changes);

    // Same fixture produces identical reports, so deltas are 0, triggering convergence at iteration 2
    assert.strictEqual(conclusion.status, "converged");
    assert.strictEqual(conclusion.iterationCount, 2); // First has no prev, second has 0 delta = converged
    assert.strictEqual(conclusion.iterationLog.length, 2);
  });

  it("detects convergence when deltas are below threshold", () => {
    const outputDir = join(TEMP_DIR, "convergence-test");
    
    // Create a mock comparison function that returns identical reports
    // Since runComparison is deterministic for fixtures, we need a custom threshold
    const conclusion = runExperimentLoop("low-unknown", outputDir, ["run 1", "run 2"], {
      convergenceThreshold: 100, // Very high threshold — any change "converges"
    });

    // After first iteration, no delta to compare, so no convergence
    // After second iteration, delta is computed but typically non-zero
    // With very high threshold (100), it should converge
    assert.strictEqual(conclusion.status, "converged");
    assert.strictEqual(conclusion.iterationCount, 2);
  });

  it("writes EXPERIMENT-CONCLUSION.json to output directory", () => {
    const outputDir = join(TEMP_DIR, "conclusion-file-test");
    runExperimentLoop("low-unknown", outputDir, ["change 1"]);

    const conclusionPath = join(outputDir, "EXPERIMENT-CONCLUSION.json");
    assert.ok(existsSync(conclusionPath));

    const readBack = readConclusion(outputDir);
    assert(readBack !== null);
    assert.strictEqual(readBack.status, "non-converged");
    assert.strictEqual(readBack.iterationCount, 1);
  });

  it("records delta summary for subsequent iterations", () => {
    const outputDir = join(TEMP_DIR, "delta-test");
    const conclusion = runExperimentLoop("low-unknown", outputDir, ["run 1", "run 2"]);

    assert.strictEqual(conclusion.iterationLog.length, 2);
    
    // First iteration has no previous, so deltaSummary should be empty or undefined
    assert.strictEqual(Object.keys(conclusion.iterationLog[0].deltaSummary).length, 0);
    
    // Second iteration should have delta computed
    assert.ok(Object.keys(conclusion.iterationLog[1].deltaSummary).length > 0);
    // Should have token deltas at minimum
    assert.ok("tokensBaselineInput" in conclusion.iterationLog[1].deltaSummary);
  });

  it("respects custom maxIterations option", () => {
    const outputDir = join(TEMP_DIR, "custom-max");
    const changes = ["change 1", "change 2"];
    
    const conclusion = runExperimentLoop("low-unknown", outputDir, changes, {
      maxIterations: 1, // Request only 1 iteration
    });

    // maxIterations is capped at 3, so 2 changes won't be bounded
    // But if we request maxIterations: 1 with 2 changes, it should be bounded
    assert.strictEqual(conclusion.status, "bounded");
    assert.strictEqual(conclusion.iterationCount, 0);
  });
});

// ─── Conclusion Validation Tests ───────────────────────────────────────────────

describe("validateConclusion", () => {
  function validConclusion(): ExperimentConclusion {
    return {
      status: "converged",
      fixtureId: "test-fixture",
      iterationCount: 2,
      iterationLog: [
        { iteration: 1, change: "initial", deltaSummary: {}, reportPath: "/path/to/report1.json" },
        { iteration: 2, change: "tweak", deltaSummary: { tokensBaselineInput: 10 }, reportPath: "/path/to/report2.json" },
      ],
      finalReportPath: "/path/to/report2.json",
      concludedAt: new Date().toISOString(),
    };
  }

  it("accepts valid conclusion with converged status", () => {
    const conclusion = validConclusion();
    assert.doesNotThrow(() => validateConclusion(conclusion));
  });

  it("accepts valid conclusion with non-converged status", () => {
    const conclusion = { ...validConclusion(), status: "non-converged" as const };
    assert.doesNotThrow(() => validateConclusion(conclusion));
  });

  it("accepts valid conclusion with bounded status", () => {
    const conclusion = { ...validConclusion(), status: "bounded" as const };
    assert.doesNotThrow(() => validateConclusion(conclusion));
  });

  it("rejects invalid status value", () => {
    const conclusion = { ...validConclusion(), status: "invalid" };
    assert.throws(
      () => validateConclusion(conclusion),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("status"));
        return true;
      },
    );
  });

  it("rejects missing fixtureId", () => {
    const conclusion = { ...validConclusion(), fixtureId: undefined };
    assert.throws(
      () => validateConclusion(conclusion),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("fixtureId"));
        return true;
      },
    );
  });

  it("rejects non-number iterationCount", () => {
    const conclusion = { ...validConclusion(), iterationCount: "two" };
    assert.throws(
      () => validateConclusion(conclusion),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("iterationCount"));
        return true;
      },
    );
  });

  it("rejects non-array iterationLog", () => {
    const conclusion = { ...validConclusion(), iterationLog: "not an array" };
    assert.throws(
      () => validateConclusion(conclusion),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("iterationLog"));
        return true;
      },
    );
  });

  it("rejects iterationLog entry with missing fields", () => {
    const conclusion = validConclusion();
    conclusion.iterationLog[0] = { iteration: 1 } as ExperimentConclusion["iterationLog"][0];
    
    assert.throws(
      () => validateConclusion(conclusion),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("change"));
        return true;
      },
    );
  });

  it("rejects non-object input", () => {
    assert.throws(
      () => validateConclusion(null),
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("must be an object"));
        return true;
      },
    );

    assert.throws(
      () => validateConclusion("not an object"),
      (err) => {
        assert(err instanceof Error);
        return true;
      },
    );
  });

  it("accepts conclusion with empty iterationLog", () => {
    const conclusion = { ...validConclusion(), iterationLog: [], iterationCount: 0 };
    assert.doesNotThrow(() => validateConclusion(conclusion));
  });
});

// ─── Read Conclusion Tests ──────────────────────────────────────────────────────

describe("readConclusion", () => {
  beforeEach(() => setupTempDir());
  afterEach(() => teardownTempDir());

  it("returns null for missing file", () => {
    const missingDir = join(TEMP_DIR, "nonexistent");
    assert.strictEqual(readConclusion(missingDir), null);
  });

  it("returns parsed conclusion for valid file", () => {
    const outputDir = join(TEMP_DIR, "read-test");
    mkdirSync(outputDir, { recursive: true });

    const conclusion: ExperimentConclusion = {
      status: "converged",
      fixtureId: "test-fixture",
      iterationCount: 2,
      iterationLog: [
        { iteration: 1, change: "initial", deltaSummary: {}, reportPath: "/path/report1.json" },
      ],
      finalReportPath: "/path/report2.json",
      concludedAt: new Date().toISOString(),
    };

    writeFileSync(
      join(outputDir, "EXPERIMENT-CONCLUSION.json"),
      JSON.stringify(conclusion, null, 2) + "\n",
      "utf-8"
    );

    const read = readConclusion(outputDir);
    assert(read !== null);
    assert.strictEqual(read.status, "converged");
    assert.strictEqual(read.fixtureId, "test-fixture");
    assert.strictEqual(read.iterationCount, 2);
  });

  it("returns null for invalid JSON", () => {
    const outputDir = join(TEMP_DIR, "invalid-json");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "EXPERIMENT-CONCLUSION.json"), "{ invalid", "utf-8");

    assert.strictEqual(readConclusion(outputDir), null);
  });
});

// ─── Constants Tests ────────────────────────────────────────────────────────────

describe("constants", () => {
  it("MAX_ITERATIONS is 3", () => {
    assert.strictEqual(MAX_ITERATIONS, 3);
  });

  it("DEFAULT_CONVERGENCE_THRESHOLD is 0.01", () => {
    assert.strictEqual(DEFAULT_CONVERGENCE_THRESHOLD, 0.01);
  });
});
