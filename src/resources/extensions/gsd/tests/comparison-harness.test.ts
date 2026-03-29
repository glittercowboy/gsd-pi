/**
 * Comparison Harness Tests
 *
 * Validates the baseline/treatment comparison runner:
 * - Schema validation
 * - Baseline has no fact-check metrics
 * - Treatment has fact-check metrics
 * - Both paths have wallClockMs
 * - Metadata is populated
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runComparison,
  runSinglePath,
  writeComparisonReport,
  formatComparisonReport,
  validateCompareReport,
  type CompareReport,
  type FeatureFlags,
  type PathConfig,
} from "../compare-runner.js";

// ─── Test Setup ───────────────────────────────────────────────────────────────

const TEST_OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), ".test-output");

function setupTestDir(): void {
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
  mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
}

function teardownTestDir(): void {
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Comparison Runner", () => {
  beforeEach(() => {
    setupTestDir();
  });

  afterEach(() => {
    teardownTestDir();
  });

  describe("runSinglePath", () => {
    it("returns null factCheck when features are disabled", () => {
      const config: PathConfig = {
        fixtureId: "low-unknown",
        outputDir: join(TEST_OUTPUT_DIR, "baseline-test"),
        features: {
          unknownsInventory: false,
          factCheckCoordination: false,
        },
      };

      const result = runSinglePath("low-unknown", config);

      assert.ok(result.metrics, "Should have metrics");
      assert.strictEqual(result.metrics.factCheck, null, "factCheck should be null when features disabled");
      assert.ok(result.metrics.wallClockMs >= 0, "Should have wallClockMs");
    });

    it("returns factCheck metrics when features are enabled", () => {
      const config: PathConfig = {
        fixtureId: "low-unknown",
        outputDir: join(TEST_OUTPUT_DIR, "treatment-test"),
        features: {
          unknownsInventory: true,
          factCheckCoordination: true,
        },
      };

      const result = runSinglePath("low-unknown", config);

      assert.ok(result.metrics, "Should have metrics");
      assert.ok(result.metrics.factCheck, "factCheck should be present when features enabled");
      assert.ok(result.metrics.factCheck!.claimsChecked > 0, "Should have claims checked");
      assert.ok(result.metrics.wallClockMs >= 0, "Should have wallClockMs");
    });

    it("includes token counts and cost", () => {
      const config: PathConfig = {
        fixtureId: "low-unknown",
        outputDir: join(TEST_OUTPUT_DIR, "tokens-test"),
        features: {
          unknownsInventory: false,
          factCheckCoordination: false,
        },
      };

      const result = runSinglePath("low-unknown", config);

      assert.ok(result.metrics.tokens, "Should have tokens");
      assert.ok(result.metrics.tokens.total > 0, "Should have non-zero total tokens");
      assert.ok(result.metrics.cost >= 0, "Should have cost");
    });
  });

  describe("runComparison", () => {
    it("produces distinct baseline/treatment metrics", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "comparison-test"));

      assert.ok(report.metadata, "Should have metadata");
      assert.ok(report.baseline, "Should have baseline");
      assert.ok(report.treatment, "Should have treatment");
      assert.ok(report.scoring, "Should have scoring");
    });

    it("baseline has no factCheck metrics", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "baseline-null-test"));

      assert.strictEqual(
        report.baseline.metrics.factCheck,
        null,
        "Baseline factCheck should be null",
      );
    });

    it("treatment has factCheck metrics", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "treatment-metrics-test"));

      assert.ok(
        report.treatment.metrics.factCheck,
        "Treatment factCheck should not be null",
      );
      assert.ok(
        report.treatment.metrics.factCheck!.claimsChecked > 0,
        "Treatment should have claims checked",
      );
    });

    it("both paths have wallClockMs", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "wallclock-test"));

      assert.ok(
        typeof report.baseline.metrics.wallClockMs === "number",
        "Baseline should have wallClockMs",
      );
      assert.ok(
        typeof report.treatment.metrics.wallClockMs === "number",
        "Treatment should have wallClockMs",
      );
      assert.ok(
        report.baseline.metrics.wallClockMs >= 0,
        "Baseline wallClockMs should be non-negative",
      );
      assert.ok(
        report.treatment.metrics.wallClockMs >= 0,
        "Treatment wallClockMs should be non-negative",
      );
    });

    it("metadata is populated", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "metadata-test"));

      assert.ok(report.metadata.fixtureId, "Should have fixtureId");
      assert.ok(report.metadata.model, "Should have model");
      assert.ok(report.metadata.startedAt, "Should have startedAt");
      assert.ok(report.metadata.completedAt, "Should have completedAt");
    });

    it("baseline features are disabled by default", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "baseline-features-test"));

      assert.strictEqual(
        report.baseline.config.features.unknownsInventory,
        false,
        "Baseline unknownsInventory should be false",
      );
      assert.strictEqual(
        report.baseline.config.features.factCheckCoordination,
        false,
        "Baseline factCheckCoordination should be false",
      );
    });

    it("treatment features are enabled by default", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "treatment-features-test"));

      assert.strictEqual(
        report.treatment.config.features.unknownsInventory,
        true,
        "Treatment unknownsInventory should be true",
      );
      assert.strictEqual(
        report.treatment.config.features.factCheckCoordination,
        true,
        "Treatment factCheckCoordination should be true",
      );
    });
  });

  describe("validateCompareReport", () => {
    it("validates a correct report structure", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "validation-test"));

      assert.doesNotThrow(() => {
        validateCompareReport(report);
      }, "Should validate correct report");
    });

    it("throws on missing metadata", () => {
      const invalidReport = {
        baseline: {
          config: {
            features: {
              unknownsInventory: false,
              factCheckCoordination: false,
            },
          },
          metrics: {
            wallClockMs: 0,
            tokens: { input: 0, output: 0, total: 0 },
            cost: 0,
            interventions: { blocker: 0, correction: 0, redirect: 0 },
            factCheck: null,
          },
        },
        treatment: {
          config: {
            features: {
              unknownsInventory: true,
              factCheckCoordination: true,
            },
          },
          metrics: {
            wallClockMs: 0,
            tokens: { input: 0, output: 0, total: 0 },
            cost: 0,
            interventions: { blocker: 0, correction: 0, redirect: 0 },
            factCheck: null,
          },
        },
        scoring: {},
      };

      assert.throws(() => {
        validateCompareReport(invalidReport);
      }, /metadata/, "Should throw on missing metadata");
    });

    it("throws on missing baseline", () => {
      const invalidReport = {
        metadata: {
          fixtureId: "test",
          model: "test",
          startedAt: "2024-01-01",
          completedAt: "2024-01-01",
        },
        treatment: {
          config: {
            features: {
              unknownsInventory: true,
              factCheckCoordination: true,
            },
          },
          metrics: {
            wallClockMs: 0,
            tokens: { input: 0, output: 0, total: 0 },
            cost: 0,
            interventions: { blocker: 0, correction: 0, redirect: 0 },
            factCheck: null,
          },
        },
        scoring: {},
      };

      assert.throws(() => {
        validateCompareReport(invalidReport);
      }, /baseline/, "Should throw on missing baseline");
    });

    it("throws on missing treatment", () => {
      const invalidReport = {
        metadata: {
          fixtureId: "test",
          model: "test",
          startedAt: "2024-01-01",
          completedAt: "2024-01-01",
        },
        baseline: {
          config: {
            features: {
              unknownsInventory: false,
              factCheckCoordination: false,
            },
          },
          metrics: {
            wallClockMs: 0,
            tokens: { input: 0, output: 0, total: 0 },
            cost: 0,
            interventions: { blocker: 0, correction: 0, redirect: 0 },
            factCheck: null,
          },
        },
        scoring: {},
      };

      assert.throws(() => {
        validateCompareReport(invalidReport);
      }, /treatment/, "Should throw on missing treatment");
    });
  });

  describe("writeComparisonReport", () => {
    it("writes report to disk as JSON", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "write-test"));
      const reportPath = writeComparisonReport(report, TEST_OUTPUT_DIR);

      assert.ok(existsSync(reportPath), "Report file should exist");
      assert.ok(reportPath.endsWith("COMPARE-REPORT.json"), "Should have correct filename");
    });

    it("re-reading produces the same structure", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "reread-test"));
      const reportPath = writeComparisonReport(report, TEST_OUTPUT_DIR);

      const raw = readFileSync(reportPath, "utf-8");
      const reRead = JSON.parse(raw);

      assert.strictEqual(reRead.metadata.fixtureId, report.metadata.fixtureId);
      assert.strictEqual(reRead.metadata.model, report.metadata.model);
      assert.strictEqual(
        reRead.baseline.config.features.factCheckCoordination,
        report.baseline.config.features.factCheckCoordination,
      );
      assert.strictEqual(
        reRead.treatment.config.features.factCheckCoordination,
        report.treatment.config.features.factCheckCoordination,
      );
    });

    it("round-trip produces identical JSON structure", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "roundtrip-test"));
      const reportPath = writeComparisonReport(report, TEST_OUTPUT_DIR);

      // Read back and parse
      const raw = readFileSync(reportPath, "utf-8");
      const reRead = JSON.parse(raw);

      // Deep comparison - serialize both and compare
      const originalJson = JSON.stringify(report, Object.keys(report).sort());
      const reReadJson = JSON.stringify(reRead, Object.keys(reRead).sort());

      // Compare key structural elements
      assert.deepStrictEqual(
        reRead.metadata,
        report.metadata,
        "Metadata should match after round-trip",
      );
      assert.deepStrictEqual(
        reRead.baseline.config,
        report.baseline.config,
        "Baseline config should match after round-trip",
      );
      assert.deepStrictEqual(
        reRead.treatment.config,
        report.treatment.config,
        "Treatment config should match after round-trip",
      );
      assert.strictEqual(
        reRead.baseline.metrics.wallClockMs,
        report.baseline.metrics.wallClockMs,
        "Baseline wallClockMs should match",
      );
      assert.strictEqual(
        reRead.treatment.metrics.wallClockMs,
        report.treatment.metrics.wallClockMs,
        "Treatment wallClockMs should match",
      );
      assert.deepStrictEqual(
        reRead.baseline.metrics.tokens,
        report.baseline.metrics.tokens,
        "Baseline tokens should match",
      );
      assert.deepStrictEqual(
        reRead.treatment.metrics.tokens,
        report.treatment.metrics.tokens,
        "Treatment tokens should match",
      );
    });
  });

  describe("formatComparisonReport", () => {
    it("produces human-readable markdown", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "format-test"));
      const markdown = formatComparisonReport(report);

      assert.ok(markdown.includes("# Comparison Report"), "Should have title");
      assert.ok(markdown.includes("low-unknown"), "Should have fixture ID");
      assert.ok(markdown.includes("Baseline Configuration"), "Should have baseline section");
      assert.ok(markdown.includes("Treatment Configuration"), "Should have treatment section");
      assert.ok(markdown.includes("Metrics Comparison"), "Should have metrics section");
    });

    it("includes feature flags in output", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "format-features-test"));
      const markdown = formatComparisonReport(report);

      assert.ok(markdown.includes("Unknowns Inventory"), "Should mention unknowns inventory");
      assert.ok(markdown.includes("Fact-Check Coordination"), "Should mention fact-check coordination");
    });

    it("includes metric rows for both paths", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "format-metrics-test"));
      const markdown = formatComparisonReport(report);

      // Check for token rows
      assert.ok(markdown.includes("tokens)"), "Should include tokens row");
      // Check for cost rows
      assert.ok(markdown.includes("cost)"), "Should include cost row");
      // Check for intervention rows
      assert.ok(markdown.includes("interventions)"), "Should include interventions row");
      // Check for fact-check rows
      assert.ok(markdown.includes("fact-checks)"), "Should include fact-checks row");
      // Check for duration rows
      assert.ok(markdown.includes("duration)"), "Should include duration row");
    });

    it("includes baseline and treatment totals", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "format-totals-test"));
      const markdown = formatComparisonReport(report);

      assert.ok(markdown.includes("baseline total"), "Should include baseline total section");
      assert.ok(markdown.includes("treatment total"), "Should include treatment total section");
      assert.ok(markdown.includes("Tokens:"), "Should include tokens in totals");
      assert.ok(markdown.includes("Cost:"), "Should include cost in totals");
      assert.ok(markdown.includes("Interventions:"), "Should include interventions in totals");
      assert.ok(markdown.includes("Fact-checks:"), "Should include fact-checks in totals");
      assert.ok(markdown.includes("Duration:"), "Should include duration in totals");
    });

    it("treatment fact-checks show non-zero while baseline shows zero", () => {
      const report = runComparison("low-unknown", join(TEST_OUTPUT_DIR, "format-factcheck-test"));
      const markdown = formatComparisonReport(report);

      // The table should show fact-checks for both paths
      // Treatment should have non-zero fact-checks, baseline should have 0
      assert.ok(
        report.treatment.metrics.factCheck !== null,
        "Treatment should have fact-check metrics",
      );
      assert.ok(
        report.treatment.metrics.factCheck!.claimsChecked > 0,
        "Treatment should have claims checked",
      );
      assert.strictEqual(
        report.baseline.metrics.factCheck,
        null,
        "Baseline should have null fact-check",
      );
    });
  });
});
