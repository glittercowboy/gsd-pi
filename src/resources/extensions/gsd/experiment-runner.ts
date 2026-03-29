/**
 * GSD Experiment Runner — Fidelity Scoring and Bounded Iteration Protocol
 *
 * Provides:
 * - FidelityRubric schema for subjective quality scoring
 * - Scoring capture that writes into comparison reports
 * - Bounded iteration runner for experiment loops (max 3 iterations)
 * - Convergence conclusion artifact generation
 *
 * @module experiment-runner
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CompareReport, SummarizedMetrics } from "./compare-runner.js";
import { runComparison, writeComparisonReport } from "./compare-runner.js";
import { saveJsonFile as writeJsonFile } from "./json-persistence.js";

// ─── Local JSON helpers ────────────────────────────────────────────────────────

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Human fidelity scoring rubric dimensions (1-5 scale). */
export interface FidelityRubric {
  /** Accuracy of facts and claims (1 = many errors, 5 = fully accurate) */
  factualAccuracy: number;
  /** Coverage of required information (1 = missing key points, 5 = comprehensive) */
  completeness: number;
  /** Logical flow and organization (1 = disjointed, 5 = well-structured) */
  coherence: number;
  /** Clarity and brevity (1 = verbose/unclear, 5 = concise and clear) */
  conciseness: number;
  /** Optional free-form notes from the human evaluator */
  notes?: string;
}

/** Scoring slot in CompareReport, populated after human evaluation. */
export interface ScoringSlot {
  baseline?: FidelityRubric;
  treatment?: FidelityRubric;
}

/** Custom error for rubric validation failures. */
export class FidelityRubricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FidelityRubricError";
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

const RUBRIC_DIMENSIONS: (keyof Omit<FidelityRubric, "notes">)[] = [
  "factualAccuracy",
  "completeness",
  "coherence",
  "conciseness",
];

/**
 * Validate a fidelity rubric.
 *
 * Checks that:
 * - All required dimensions are present
 * - All dimension values are integers in range 1-5
 *
 * @param rubric - The rubric to validate
 * @throws FidelityRubricError if validation fails
 */
export function validateRubric(rubric: unknown): asserts rubric is FidelityRubric {
  if (typeof rubric !== "object" || rubric === null) {
    throw new FidelityRubricError("Rubric must be an object");
  }

  const r = rubric as Record<string, unknown>;

  for (const dim of RUBRIC_DIMENSIONS) {
    const value = r[dim];

    if (value === undefined) {
      throw new FidelityRubricError(`Missing required dimension: ${dim}`);
    }

    if (typeof value !== "number") {
      throw new FidelityRubricError(`Dimension ${dim} must be a number, got ${typeof value}`);
    }

    if (!Number.isInteger(value)) {
      throw new FidelityRubricError(`Dimension ${dim} must be an integer, got ${value}`);
    }

    if (value < 1 || value > 5) {
      throw new FidelityRubricError(`Dimension ${dim} must be in range 1-5, got ${value}`);
    }
  }

  // notes is optional, but if present must be a string
  if (r.notes !== undefined && typeof r.notes !== "string") {
    throw new FidelityRubricError(`notes must be a string if present, got ${typeof r.notes}`);
  }
}

/**
 * Check if a rubric is valid without throwing.
 * Useful for conditional logic before capture.
 */
export function isValidRubric(rubric: unknown): rubric is FidelityRubric {
  try {
    validateRubric(rubric);
    return true;
  } catch {
    return false;
  }
}

// ─── Scoring Capture ───────────────────────────────────────────────────────────

/**
 * Capture a fidelity rubric score into a comparison report.
 *
 * Reads the report from disk, merges the rubric into the scoring section
 * for the specified path (baseline or treatment), and writes back.
 *
 * @param reportPath - Path to the COMPARE-REPORT.json file
 * @param path - Which path to score ('baseline' or 'treatment')
 * @param rubric - The fidelity rubric to capture
 * @throws FidelityRubricError if rubric validation fails
 * @throws Error if report file doesn't exist or is invalid JSON
 */
export function captureScoring(
  reportPath: string,
  path: "baseline" | "treatment",
  rubric: FidelityRubric,
): void {
  // Validate rubric first
  validateRubric(rubric);

  // Check report exists
  if (!existsSync(reportPath)) {
    throw new Error(`Report file not found: ${reportPath}`);
  }

  // Read and parse report
  let report: CompareReport;
  try {
    report = readJsonFile<CompareReport>(reportPath);
  } catch (e) {
    throw new Error(`Failed to parse report at ${reportPath}: ${e}`);
  }

  // Ensure scoring object exists
  if (!report.scoring || typeof report.scoring !== "object") {
    report.scoring = {};
  }

  // Merge rubric into scoring section
  const scoring = report.scoring as unknown as Record<string, FidelityRubric>;
  scoring[path] = rubric;
  report.scoring = scoring as CompareReport["scoring"];

  // Write back
  writeJsonFile(reportPath, report);

  // Log capture for observability
  console.log(`[EXPERIMENT] scoring captured for ${path} in ${reportPath}`);
}

/**
 * Read scoring from a comparison report.
 * Returns the scoring slot or null if not present.
 */
export function readScoring(reportPath: string): ScoringSlot | null {
  if (!existsSync(reportPath)) {
    return null;
  }

  try {
    const report = readJsonFile<CompareReport>(reportPath);

    if (!report.scoring || typeof report.scoring !== "object") {
      return null;
    }

    return report.scoring as ScoringSlot;
  } catch {
    return null;
  }
}

/**
 * Compute average score across all dimensions.
 * Useful for quick comparisons.
 */
export function averageScore(rubric: FidelityRubric): number {
  const sum = RUBRIC_DIMENSIONS.reduce((acc, dim) => acc + rubric[dim], 0);
  return sum / RUBRIC_DIMENSIONS.length;
}

/**
 * Compare two rubrics and return the difference.
 * Positive values mean treatment is better.
 */
export function compareRubrics(
  baseline: FidelityRubric,
  treatment: FidelityRubric,
): Record<keyof Omit<FidelityRubric, "notes">, number> {
  return {
    factualAccuracy: treatment.factualAccuracy - baseline.factualAccuracy,
    completeness: treatment.completeness - baseline.completeness,
    coherence: treatment.coherence - baseline.coherence,
    conciseness: treatment.conciseness - baseline.conciseness,
  };
}

// ─── Bounded Iteration Types ────────────────────────────────────────────────────

/** Maximum number of iterations allowed in experiment loop. */
export const MAX_ITERATIONS = 3;

/** Default threshold for convergence detection (all deltas must be below this). */
export const DEFAULT_CONVERGENCE_THRESHOLD = 0.01;

/** Status of an experiment loop conclusion. */
export type ConclusionStatus = "converged" | "non-converged" | "bounded";

/** Entry in the iteration log recording what changed per iteration. */
export interface IterationEntry {
  /** Iteration number (1-indexed) */
  iteration: number;
  /** Human-readable description of what changed in this iteration */
  change: string;
  /** Summary of metric differences from previous iteration */
  deltaSummary: Record<string, number>;
  /** Path to the comparison report for this iteration */
  reportPath: string;
}

/** Final conclusion artifact from a bounded experiment loop. */
export interface ExperimentConclusion {
  /** Whether converged, non-converged, or bounded by max iterations */
  status: ConclusionStatus;
  /** The fixture that was tested */
  fixtureId: string;
  /** Number of iterations actually run */
  iterationCount: number;
  /** Log of each iteration's changes and deltas */
  iterationLog: IterationEntry[];
  /** Path to the final comparison report */
  finalReportPath: string;
  /** ISO timestamp when the experiment was concluded */
  concludedAt: string;
}

/** Options for running an experiment loop. */
export interface ExperimentLoopOptions {
  /** Maximum iterations (default: 3, enforced max: 3) */
  maxIterations?: number;
  /** Threshold for convergence detection (default: 0.01) */
  convergenceThreshold?: number;
  /** Optional model override */
  model?: string;
}

// ─── Delta Computation ──────────────────────────────────────────────────────────

/**
 * Compute metric deltas between two comparison reports.
 *
 * Returns differences in:
 * - Token counts (baseline and treatment)
 * - Intervention counts
 * - Fact-check metrics (when applicable)
 * - Fidelity scores (when captured)
 */
export function computeDelta(
  prevReport: CompareReport,
  currReport: CompareReport,
): Record<string, number> {
  const delta: Record<string, number> = {};

  // Token deltas
  delta.tokensBaselineInput = currReport.baseline.metrics.tokens.input - prevReport.baseline.metrics.tokens.input;
  delta.tokensBaselineOutput = currReport.baseline.metrics.tokens.output - prevReport.baseline.metrics.tokens.output;
  delta.tokensBaselineTotal = currReport.baseline.metrics.tokens.total - prevReport.baseline.metrics.tokens.total;
  delta.tokensTreatmentInput = currReport.treatment.metrics.tokens.input - prevReport.treatment.metrics.tokens.input;
  delta.tokensTreatmentOutput = currReport.treatment.metrics.tokens.output - prevReport.treatment.metrics.tokens.output;
  delta.tokensTreatmentTotal = currReport.treatment.metrics.tokens.total - prevReport.treatment.metrics.tokens.total;

  // Cost deltas
  delta.costBaseline = currReport.baseline.metrics.cost - prevReport.baseline.metrics.cost;
  delta.costTreatment = currReport.treatment.metrics.cost - prevReport.treatment.metrics.cost;

  // Intervention deltas
  delta.interventionsBaseline = 
    (currReport.baseline.metrics.interventions.blocker + 
     currReport.baseline.metrics.interventions.correction + 
     currReport.baseline.metrics.interventions.redirect) -
    (prevReport.baseline.metrics.interventions.blocker + 
     prevReport.baseline.metrics.interventions.correction + 
     prevReport.baseline.metrics.interventions.redirect);
  delta.interventionsTreatment = 
    (currReport.treatment.metrics.interventions.blocker + 
     currReport.treatment.metrics.interventions.correction + 
     currReport.treatment.metrics.interventions.redirect) -
    (prevReport.treatment.metrics.interventions.blocker + 
     prevReport.treatment.metrics.interventions.correction + 
     prevReport.treatment.metrics.interventions.redirect);

  // Fact-check deltas (only when both have fact-check data)
  const prevFactCheck = prevReport.treatment.metrics.factCheck;
  const currFactCheck = currReport.treatment.metrics.factCheck;
  if (prevFactCheck && currFactCheck) {
    delta.factCheckClaims = currFactCheck.claimsChecked - prevFactCheck.claimsChecked;
    delta.factCheckVerified = currFactCheck.verified - prevFactCheck.verified;
    delta.factCheckRefuted = currFactCheck.refuted - prevFactCheck.refuted;
    delta.factCheckInconclusive = currFactCheck.inconclusive - prevFactCheck.inconclusive;
  }

  // Fidelity score deltas (when scoring is captured)
  const prevScoring = prevReport.scoring as ScoringSlot | undefined;
  const currScoring = currReport.scoring as ScoringSlot | undefined;
  
  if (prevScoring?.baseline && currScoring?.baseline) {
    delta.fidelityBaseline = averageScore(currScoring.baseline) - averageScore(prevScoring.baseline);
  }
  if (prevScoring?.treatment && currScoring?.treatment) {
    delta.fidelityTreatment = averageScore(currScoring.treatment) - averageScore(prevScoring.treatment);
  }

  return delta;
}

/**
 * Check if all delta values are below the convergence threshold.
 */
function isConverged(delta: Record<string, number>, threshold: number): boolean {
  const values = Object.values(delta);
  if (values.length === 0) return true;
  return values.every((v) => Math.abs(v) < threshold);
}

// ─── Bounded Iteration Runner ───────────────────────────────────────────────────

/**
 * Run a bounded experiment loop that iterates through targeted changes,
 * records deltas between runs, and produces a convergence conclusion.
 *
 * @param fixtureId - The fixture to test
 * @param outputDir - Directory for output artifacts
 * @param changes - Array of change descriptions (max 3 executed)
 * @param options - Loop configuration options
 * @returns Experiment conclusion artifact
 */
export function runExperimentLoop(
  fixtureId: string,
  outputDir: string,
  changes: string[],
  options?: ExperimentLoopOptions,
): ExperimentConclusion {
  const maxIterations = Math.min(options?.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS);
  const threshold = options?.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD;

  // Check for bounded condition immediately (before executing any iteration)
  if (changes.length > maxIterations) {
    console.log(`[EXPERIMENT] bounded at iteration 0 — max ${maxIterations} exceeded (requested ${changes.length})`);
    
    const conclusion: ExperimentConclusion = {
      status: "bounded",
      fixtureId,
      iterationCount: 0,
      iterationLog: [],
      finalReportPath: "",
      concludedAt: new Date().toISOString(),
    };

    const conclusionPath = join(outputDir, "EXPERIMENT-CONCLUSION.json");
    mkdirSync(outputDir, { recursive: true });
    writeJsonFile(conclusionPath, conclusion);

    return conclusion;
  }

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  const iterationLog: IterationEntry[] = [];
  let prevReport: CompareReport | null = null;
  let finalReportPath = "";

  // Run each iteration
  for (let i = 0; i < changes.length; i++) {
    const iteration = i + 1;
    const change = changes[i];
    const iterationDir = join(outputDir, `iteration-${iteration}`);

    // Run comparison for this iteration
    const report = runComparison(fixtureId, iterationDir, { model: options?.model });
    const reportPath = writeComparisonReport(report, iterationDir);

    // Compute delta from previous iteration (if any)
    let deltaSummary: Record<string, number> = {};
    if (prevReport) {
      deltaSummary = computeDelta(prevReport, report);
      console.log(`[EXPERIMENT] iteration ${iteration}: delta=${JSON.stringify(deltaSummary)}`);
    }

    // Log this iteration
    iterationLog.push({
      iteration,
      change,
      deltaSummary,
      reportPath,
    });

    // Check for convergence
    if (prevReport && isConverged(deltaSummary, threshold)) {
      console.log(`[EXPERIMENT] converged at iteration ${iteration}`);

      const conclusion: ExperimentConclusion = {
        status: "converged",
        fixtureId,
        iterationCount: iteration,
        iterationLog,
        finalReportPath: reportPath,
        concludedAt: new Date().toISOString(),
      };

      const conclusionPath = join(outputDir, "EXPERIMENT-CONCLUSION.json");
      writeJsonFile(conclusionPath, conclusion);

      return conclusion;
    }

    prevReport = report;
    finalReportPath = reportPath;
  }

  // Did not converge — check if we hit the bound or just ran out of changes
  const status: ConclusionStatus = changes.length >= maxIterations ? "bounded" : "non-converged";

  const conclusion: ExperimentConclusion = {
    status,
    fixtureId,
    iterationCount: changes.length,
    iterationLog,
    finalReportPath,
    concludedAt: new Date().toISOString(),
  };

  const conclusionPath = join(outputDir, "EXPERIMENT-CONCLUSION.json");
  writeJsonFile(conclusionPath, conclusion);

  return conclusion;
}

/**
 * Read an experiment conclusion artifact from disk.
 */
export function readConclusion(outputDir: string): ExperimentConclusion | null {
  const conclusionPath = join(outputDir, "EXPERIMENT-CONCLUSION.json");
  
  if (!existsSync(conclusionPath)) {
    return null;
  }

  try {
    return readJsonFile<ExperimentConclusion>(conclusionPath);
  } catch {
    return null;
  }
}

/**
 * Validate an experiment conclusion has the expected structure.
 * Returns true if valid, throws on validation failure.
 */
export function validateConclusion(conclusion: unknown): conclusion is ExperimentConclusion {
  if (typeof conclusion !== "object" || conclusion === null) {
    throw new Error("Conclusion must be an object");
  }

  const c = conclusion as Record<string, unknown>;

  // Check status
  const validStatuses: ConclusionStatus[] = ["converged", "non-converged", "bounded"];
  if (!validStatuses.includes(c.status as ConclusionStatus)) {
    throw new Error(`status must be one of ${validStatuses.join(", ")}, got ${c.status}`);
  }

  // Check fixtureId
  if (typeof c.fixtureId !== "string") {
    throw new Error("fixtureId must be a string");
  }

  // Check iterationCount
  if (typeof c.iterationCount !== "number") {
    throw new Error("iterationCount must be a number");
  }

  // Check iterationLog
  if (!Array.isArray(c.iterationLog)) {
    throw new Error("iterationLog must be an array");
  }
  
  for (const entry of c.iterationLog) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("iterationLog entries must be objects");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.iteration !== "number") {
      throw new Error("iterationLog entry.iteration must be a number");
    }
    if (typeof e.change !== "string") {
      throw new Error("iterationLog entry.change must be a string");
    }
    if (typeof e.deltaSummary !== "object" || e.deltaSummary === null) {
      throw new Error("iterationLog entry.deltaSummary must be an object");
    }
    if (typeof e.reportPath !== "string") {
      throw new Error("iterationLog entry.reportPath must be a string");
    }
  }

  // Check finalReportPath
  if (typeof c.finalReportPath !== "string") {
    throw new Error("finalReportPath must be a string");
  }

  // Check concludedAt
  if (typeof c.concludedAt !== "string") {
    throw new Error("concludedAt must be a string");
  }

  return true;
}
