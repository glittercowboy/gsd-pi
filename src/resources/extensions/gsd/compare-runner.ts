/**
 * GSD Comparison Runner — Baseline vs Treatment Harness
 *
 * Executes a concept fixture through two configurations:
 * - Baseline: evidence-grounded features (unknowns inventory, fact-check) disabled
 * - Treatment: evidence-grounded features enabled
 *
 * Produces a merged comparison report with distinct metrics per path.
 * Used for experiment validation and telemetry comparison.
 *
 * @module compare-runner
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FixtureManifest } from "./tests/fixture-harness.js";
import { loadFixture, getFixturePath } from "./tests/fixture-harness.js";
import type { FactCheckMetrics, UnitMetrics, TokenCounts, MetricsLedger } from "./metrics.js";
import { extractFactCheckMetrics } from "./metrics.js";
import { summarizeMetrics, formatComparisonTable, type LedgerInput } from "./summarize-metrics.js";
import { saveJsonFile as writeJsonFile } from "./json-persistence.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Feature flags controlling evidence-grounded dispatch behavior. */
export interface FeatureFlags {
  unknownsInventory: boolean;
  factCheckCoordination: boolean;
}

/** Configuration for a single comparison path (baseline or treatment). */
export interface PathConfig {
  fixtureId: string;
  outputDir: string;
  model?: string;
  features: FeatureFlags;
}

/** Configuration for a full comparison run. */
export interface ComparisonConfig {
  fixtureId: string;
  outputDir: string;
  model?: string;
  /** Optional custom feature flags for baseline (default: all disabled) */
  baselineFeatures?: Partial<FeatureFlags>;
  /** Optional custom feature flags for treatment (default: all enabled) */
  treatmentFeatures?: Partial<FeatureFlags>;
}

/** Summarized metrics for a single comparison path. */
export interface SummarizedMetrics {
  /** Wall-clock duration in milliseconds */
  wallClockMs: number;
  /** Token counts (simulated for concept fixtures) */
  tokens: TokenCounts;
  /** Cost in USD (simulated for concept fixtures) */
  cost: number;
  /** Intervention counts (always zero for concept fixtures) */
  interventions: { blocker: number; correction: number; redirect: number };
  /** Fact-check metrics (null if features disabled, non-null if enabled) */
  factCheck: FactCheckMetrics | null;
}

/** Metadata about the comparison run. */
export interface CompareMetadata {
  fixtureId: string;
  model: string;
  startedAt: string;
  completedAt: string;
}

/** Single path result in the comparison report. */
export interface PathResult {
  config: {
    features: FeatureFlags;
  };
  metrics: SummarizedMetrics;
}

/** Complete comparison report structure. */
export interface CompareReport {
  metadata: CompareMetadata;
  baseline: PathResult;
  treatment: PathResult;
  /** Extensible scoring slot for downstream analysis */
  scoring: Record<string, unknown>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-3-5-sonnet";

const DEFAULT_BASELINE_FEATURES: FeatureFlags = {
  unknownsInventory: false,
  factCheckCoordination: false,
};

const DEFAULT_TREATMENT_FEATURES: FeatureFlags = {
  unknownsInventory: true,
  factCheckCoordination: true,
};

// ─── Simulated Token Costs (for concept fixtures) ──────────────────────────────

/** Approximate token costs per 1k tokens for cost simulation */
const COST_PER_1K_INPUT = 0.003;
const COST_PER_1K_OUTPUT = 0.015;

/**
 * Simulate token usage based on fixture characteristics.
 * Treatment path uses more tokens due to fact-check coordination overhead.
 */
function simulateTokens(manifest: FixtureManifest, features: FeatureFlags): TokenCounts {
  const baseInput = 5000; // Base input tokens for fixture
  const baseOutput = 2000; // Base output tokens

  // Treatment path has overhead for fact-check coordination
  const factCheckOverhead = features.factCheckCoordination ? 0.3 : 0;

  const input = Math.round(baseInput * (1 + factCheckOverhead));
  const output = Math.round(baseOutput * (1 + factCheckOverhead));

  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    total: input + output,
  };
}

/**
 * Simulate cost from token counts.
 */
function simulateCost(tokens: TokenCounts): number {
  const inputCost = (tokens.input / 1000) * COST_PER_1K_INPUT;
  const outputCost = (tokens.output / 1000) * COST_PER_1K_OUTPUT;
  return inputCost + outputCost;
}

// ─── Path Execution ───────────────────────────────────────────────────────────

/**
 * Result of running a single path through the fixture.
 */
interface SinglePathResult {
  metrics: SummarizedMetrics;
  durationMs: number;
}

/**
 * Run a single path through the fixture with given configuration.
 *
 * When fact-check features are enabled, extracts real metrics from the
 * fixture's factcheck state. When disabled, returns null fact-check metrics.
 */
export function runSinglePath(
  fixtureId: string,
  config: PathConfig,
): SinglePathResult {
  const startedAt = Date.now();

  // Load fixture - loadFixture creates a "state" subdirectory in outputDir
  const manifest = loadFixture(fixtureId, config.outputDir);

  // Build metrics based on feature flags
  let factCheck: FactCheckMetrics | null = null;

  if (config.features.factCheckCoordination) {
    // Extract real fact-check metrics from fixture state
    // loadFixture copies to {outputDir}/state/slices/S01/factcheck/
    const sliceDir = join(config.outputDir, "state", "slices", "S01");
    factCheck = extractFactCheckMetrics(sliceDir);
  }

  // Simulate token usage (concept fixtures don't have real LLM calls)
  const tokens = simulateTokens(manifest, config.features);
  const cost = simulateCost(tokens);

  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;

  const metrics: SummarizedMetrics = {
    wallClockMs: durationMs,
    tokens,
    cost,
    interventions: { blocker: 0, correction: 0, redirect: 0 },
    factCheck,
  };

  return { metrics, durationMs };
}

// ─── Comparison Runner ─────────────────────────────────────────────────────────

/**
 * Run a full comparison between baseline and treatment configurations.
 *
 * @param fixtureId - The fixture identifier (e.g., "low-unknown")
 * @param outputDir - Directory for output files and state copies
 * @param options - Optional configuration overrides
 * @returns Complete comparison report with distinct metrics per path
 */
export function runComparison(
  fixtureId: string,
  outputDir: string,
  options?: {
    model?: string;
    baselineFeatures?: Partial<FeatureFlags>;
    treatmentFeatures?: Partial<FeatureFlags>;
  },
): CompareReport {
  const startedAt = new Date().toISOString();
  const model = options?.model ?? DEFAULT_MODEL;

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Build feature configurations
  const baselineFeatures: FeatureFlags = {
    ...DEFAULT_BASELINE_FEATURES,
    ...options?.baselineFeatures,
  };

  const treatmentFeatures: FeatureFlags = {
    ...DEFAULT_TREATMENT_FEATURES,
    ...options?.treatmentFeatures,
  };

  // Run baseline path
  const baselineResult = runSinglePath(fixtureId, {
    fixtureId,
    outputDir: join(outputDir, "baseline"),
    model,
    features: baselineFeatures,
  });

  // Run treatment path
  const treatmentResult = runSinglePath(fixtureId, {
    fixtureId,
    outputDir: join(outputDir, "treatment"),
    model,
    features: treatmentFeatures,
  });

  const completedAt = new Date().toISOString();

  const report: CompareReport = {
    metadata: {
      fixtureId,
      model,
      startedAt,
      completedAt,
    },
    baseline: {
      config: { features: baselineFeatures },
      metrics: baselineResult.metrics,
    },
    treatment: {
      config: { features: treatmentFeatures },
      metrics: treatmentResult.metrics,
    },
    scoring: {
      // Reserved for downstream analysis
      // Could include: difference scores, effect sizes, significance tests
    },
  };

  return report;
}

// ─── Report Persistence ───────────────────────────────────────────────────────

/**
 * Write comparison report to disk as JSON.
 */
export function writeComparisonReport(report: CompareReport, outputDir: string): string {
  const reportPath = join(outputDir, "COMPARE-REPORT.json");
  writeJsonFile(reportPath, report);
  return reportPath;
}

/**
 * Generate human-readable markdown summary from comparison report.
 */
export function formatComparisonReport(report: CompareReport): string {
  const lines: string[] = [
    `# Comparison Report: ${report.metadata.fixtureId}`,
    "",
    `**Model:** ${report.metadata.model}`,
    `**Started:** ${report.metadata.startedAt}`,
    `**Completed:** ${report.metadata.completedAt}`,
    "",
    "## Baseline Configuration",
    `- Unknowns Inventory: ${report.baseline.config.features.unknownsInventory}`,
    `- Fact-Check Coordination: ${report.baseline.config.features.factCheckCoordination}`,
    "",
    "## Treatment Configuration",
    `- Unknowns Inventory: ${report.treatment.config.features.unknownsInventory}`,
    `- Fact-Check Coordination: ${report.treatment.config.features.factCheckCoordination}`,
    "",
  ];

  // Build mock ledgers for table generation
  const baselineLedger: MetricsLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [unitMetricsFromSummarized(report.baseline.metrics, "baseline")],
  };

  const treatmentLedger: MetricsLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [unitMetricsFromSummarized(report.treatment.metrics, "treatment")],
  };

  const comparison = summarizeMetrics([
    { label: "baseline", ledger: baselineLedger },
    { label: "treatment", ledger: treatmentLedger },
  ]);

  lines.push("## Metrics Comparison");
  lines.push("");
  lines.push(formatComparisonTable(comparison));

  return lines.join("\n");
}

/**
 * Convert SummarizedMetrics to UnitMetrics for table generation.
 */
function unitMetricsFromSummarized(metrics: SummarizedMetrics, label: string): UnitMetrics {
  return {
    type: `comparison-${label}`,
    id: label,
    model: "comparison",
    startedAt: Date.now() - metrics.wallClockMs,
    finishedAt: Date.now(),
    tokens: metrics.tokens,
    cost: metrics.cost,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
    interventions: metrics.interventions,
    factCheck: metrics.factCheck ?? undefined,
    wallClockMs: metrics.wallClockMs,
  };
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

/**
 * Validate that a comparison report has the expected structure.
 * Returns true if valid, throws on validation failure.
 */
export function validateCompareReport(report: unknown): report is CompareReport {
  if (typeof report !== "object" || report === null) {
    throw new Error("Report must be an object");
  }

  const r = report as Record<string, unknown>;

  // Check metadata
  if (typeof r.metadata !== "object" || r.metadata === null) {
    throw new Error("Report must have metadata object");
  }
  const meta = r.metadata as Record<string, unknown>;
  if (typeof meta.fixtureId !== "string") {
    throw new Error("metadata.fixtureId must be a string");
  }
  if (typeof meta.model !== "string") {
    throw new Error("metadata.model must be a string");
  }
  if (typeof meta.startedAt !== "string") {
    throw new Error("metadata.startedAt must be a string");
  }
  if (typeof meta.completedAt !== "string") {
    throw new Error("metadata.completedAt must be a string");
  }

  // Check baseline
  if (typeof r.baseline !== "object" || r.baseline === null) {
    throw new Error("Report must have baseline object");
  }
  validatePathResult(r.baseline, "baseline");

  // Check treatment
  if (typeof r.treatment !== "object" || r.treatment === null) {
    throw new Error("Report must have treatment object");
  }
  validatePathResult(r.treatment, "treatment");

  // Check scoring
  if (typeof r.scoring !== "object" || r.scoring === null) {
    throw new Error("Report must have scoring object");
  }

  return true;
}

function validatePathResult(result: unknown, pathName: string): void {
  if (typeof result !== "object" || result === null) {
    throw new Error(`${pathName} must be an object`);
  }

  const r = result as Record<string, unknown>;

  // Check config
  if (typeof r.config !== "object" || r.config === null) {
    throw new Error(`${pathName}.config must be an object`);
  }
  const config = r.config as Record<string, unknown>;
  if (typeof config.features !== "object" || config.features === null) {
    throw new Error(`${pathName}.config.features must be an object`);
  }
  const features = config.features as Record<string, unknown>;
  if (typeof features.unknownsInventory !== "boolean") {
    throw new Error(`${pathName}.config.features.unknownsInventory must be a boolean`);
  }
  if (typeof features.factCheckCoordination !== "boolean") {
    throw new Error(`${pathName}.config.features.factCheckCoordination must be a boolean`);
  }

  // Check metrics
  if (typeof r.metrics !== "object" || r.metrics === null) {
    throw new Error(`${pathName}.metrics must be an object`);
  }
  const metrics = r.metrics as Record<string, unknown>;
  if (typeof metrics.wallClockMs !== "number") {
    throw new Error(`${pathName}.metrics.wallClockMs must be a number`);
  }
  if (typeof metrics.tokens !== "object" || metrics.tokens === null) {
    throw new Error(`${pathName}.metrics.tokens must be an object`);
  }
  if (typeof metrics.cost !== "number") {
    throw new Error(`${pathName}.metrics.cost must be a number`);
  }
  if (typeof metrics.interventions !== "object" || metrics.interventions === null) {
    throw new Error(`${pathName}.metrics.interventions must be an object`);
  }
  // factCheck can be null or object
  if (metrics.factCheck !== null && typeof metrics.factCheck !== "object") {
    throw new Error(`${pathName}.metrics.factCheck must be null or an object`);
  }
}
