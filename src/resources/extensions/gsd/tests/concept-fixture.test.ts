/**
 * Concept Fixture Tests — Manifest Validation and Loader Integration
 *
 * Validates both concept fixtures (low-unknown, high-unknown) have required
 * manifest contract fields and proves the loader utility correctly copies
 * fixture state for metrics extraction.
 *
 * Run: npx tsx --test src/resources/extensions/gsd/tests/concept-fixture.test.ts
 */

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadFixture,
  getFixturePath,
  type FixtureManifest,
} from "./fixture-harness.ts";
import { extractFactCheckMetrics } from "../metrics.js";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

const FIXTURE_IDS = ["low-unknown", "high-unknown"] as const;

// ─── Manifest Validation Tests ────────────────────────────────────────────────

console.log("\n=== Manifest Field Validation ===");

for (const fixtureId of FIXTURE_IDS) {
  const manifestPath = join(getFixturePath(fixtureId), "FIXTURE-MANIFEST.json");
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: FixtureManifest = JSON.parse(raw);

  // Required top-level fields
  assertTrue("id" in manifest, `${fixtureId}: manifest has 'id' field`);
  assertTrue("scenarioDescription" in manifest, `${fixtureId}: manifest has 'scenarioDescription' field`);
  assertTrue("claimMix" in manifest, `${fixtureId}: manifest has 'claimMix' field`);
  assertTrue("expectedTelemetryShape" in manifest, `${fixtureId}: manifest has 'expectedTelemetryShape' field`);
  assertTrue("successCriteria" in manifest, `${fixtureId}: manifest has 'successCriteria' field`);
  assertTrue("claims" in manifest, `${fixtureId}: manifest has 'claims' field`);
  assertTrue("requiredFiles" in manifest, `${fixtureId}: manifest has 'requiredFiles' field`);

  // claimMix structure
  assertTrue(
    "total" in manifest.claimMix,
    `${fixtureId}: claimMix has 'total' field`,
  );
  assertTrue(
    "confirmed" in manifest.claimMix,
    `${fixtureId}: claimMix has 'confirmed' field`,
  );
  assertTrue(
    "refuted" in manifest.claimMix,
    `${fixtureId}: claimMix has 'refuted' field`,
  );
  assertTrue(
    "inconclusive" in manifest.claimMix,
    `${fixtureId}: claimMix has 'inconclusive' field`,
  );

  // Claims array length matches claimMix.total
  assertEq(
    manifest.claims.length,
    manifest.claimMix.total,
    `${fixtureId}: claims array length matches claimMix.total`,
  );

  // expectedTelemetryShape structure
  assertTrue(
    "factCheck" in manifest.expectedTelemetryShape,
    `${fixtureId}: expectedTelemetryShape has 'factCheck' field`,
  );
  assertTrue(
    "interventions" in manifest.expectedTelemetryShape,
    `${fixtureId}: expectedTelemetryShape has 'interventions' field`,
  );
}

// ─── Loader + Extraction Integration Tests ────────────────────────────────────

console.log("\n=== Loader + extractFactCheckMetrics Integration ===");

for (const fixtureId of FIXTURE_IDS) {
  const tempDir = mkdtempSync(join(tmpdir(), `gsd-fixture-${fixtureId}-`));

  try {
    // Load fixture into temp directory
    // loadFixture copies state/ to targetBase/state/, so we pass tempDir
    // Resulting structure: tempDir/state/slices/S01/factcheck/
    const manifest = loadFixture(fixtureId, tempDir);

    assertTrue(manifest !== null, `${fixtureId}: loadFixture returns manifest object`);
    assertEq(manifest.id.includes(fixtureId) || manifest.id.includes("concept"), true, `${fixtureId}: manifest id contains fixture identifier`);

    // Extract metrics from loaded state
    // loadFixture copies state/ into tempDir/state/, so slice path is:
    // tempDir/state/slices/S01/factcheck
    const sliceDir = join(tempDir, "state", "slices", "S01");
    const metrics = extractFactCheckMetrics(sliceDir);

    assertTrue(metrics !== null, `${fixtureId}: extractFactCheckMetrics returns non-null from loaded state`);

    // Verify counts match manifest claimMix
    assertEq(
      metrics!.claimsChecked,
      manifest.claimMix.total,
      `${fixtureId}: claimsChecked matches claimMix.total`,
    );
    assertEq(
      metrics!.verified,
      manifest.claimMix.confirmed,
      `${fixtureId}: verified matches claimMix.confirmed`,
    );
    assertEq(
      metrics!.refuted,
      manifest.claimMix.refuted,
      `${fixtureId}: refuted matches claimMix.refuted`,
    );
    assertEq(
      metrics!.inconclusive,
      manifest.claimMix.inconclusive,
      `${fixtureId}: inconclusive matches claimMix.inconclusive`,
    );

    // All claims should have scoutTokens, so sum should be > 0
    assertTrue(
      metrics!.scoutTokens > 0,
      `${fixtureId}: scoutTokens > 0 (all claims contribute tokens)`,
    );

    // Verify expectedTelemetryShape matches extracted metrics
    const expectedFc = manifest.expectedTelemetryShape.factCheck;
    assertEq(
      metrics!.claimsChecked,
      expectedFc.claimsChecked,
      `${fixtureId}: claimsChecked matches expectedTelemetryShape.factCheck.claimsChecked`,
    );
    assertEq(
      metrics!.verified,
      expectedFc.verified,
      `${fixtureId}: verified matches expectedTelemetryShape.factCheck.verified`,
    );
    assertEq(
      metrics!.refuted,
      expectedFc.refuted,
      `${fixtureId}: refuted matches expectedTelemetryShape.factCheck.refuted`,
    );
    assertEq(
      metrics!.inconclusive,
      expectedFc.inconclusive,
      `${fixtureId}: inconclusive matches expectedTelemetryShape.factCheck.inconclusive`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ─── Error Handling Tests ──────────────────────────────────────────────────────

console.log("\n=== Error Handling ===");

{
  // Test loadFixture with nonexistent fixture throws expected error
  let threw = false;
  try {
    getFixturePath("nonexistent-fixture");
  } catch (err) {
    threw = true;
    assertTrue(
      err instanceof Error,
      "getFixturePath throws Error for nonexistent fixture",
    );
    assertTrue(
      (err as Error).message.includes("Fixture not found"),
      "error message contains 'Fixture not found'",
    );
  }
  assertTrue(threw, "getFixturePath throws for nonexistent fixture");
}

{
  // Test extractFactCheckMetrics with missing directory returns null
  const metrics = extractFactCheckMetrics("/nonexistent/path/S01");
  assertEq(metrics, null, "extractFactCheckMetrics returns null for missing directory");
}

report();
