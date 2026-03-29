/**
 * Fixture Harness — Concept Fixture Loader Utility
 *
 * Provides utilities for loading concept fixtures with manifest contracts
 * into test environments. Each fixture represents a known fact-check scenario
 * with pre-built state trees and expected telemetry shapes.
 *
 * Usage:
 *   import { loadFixture, getFixturePath } from './fixture-harness.ts';
 *   const manifest = loadFixture('low-unknown', '/tmp/test-state');
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single claim entry in the fixture manifest. */
export interface FixtureClaim {
  claimId: string;
  text: string;
  source: string;
  verdict: "confirmed" | "refuted" | "inconclusive" | "unresolved";
  confidence: number;
}

/** Claim mix summary for expected verification outcomes. */
export interface ClaimMix {
  total: number;
  confirmed: number;
  refuted: number;
  inconclusive: number;
  unresolved: number;
}

/** Expected intervention telemetry shape. */
export interface ExpectedInterventions {
  expected: boolean;
  minBlockers?: number;
}

/** Expected fact-check telemetry shape. */
export interface ExpectedFactCheck {
  claimsChecked: number;
  verified: number;
  refuted: number;
  inconclusive: number;
}

/** Expected telemetry shape for the fixture scenario. */
export interface ExpectedTelemetryShape {
  interventions: ExpectedInterventions;
  factCheck: ExpectedFactCheck;
  wallClockMs: boolean;
}

/** Success criteria for validating fixture execution. */
export interface SuccessCriteria {
  maxInterventions: number;
  minVerifiedRatio: number;
}

/** Redaction constraints for safe fixture data. */
export interface RedactionConstraints {
  secretsPresent: boolean;
  personalDataPresent: boolean;
  syntheticOnly: boolean;
}

/**
 * Complete fixture manifest schema for concept fixtures.
 * Defines the contract between fixture state and expected outcomes.
 */
export interface FixtureManifest {
  id: string;
  scenarioDescription: string;
  milestoneId: string;
  sliceId: string;
  createdAt: string;
  version: number;
  claimMix: ClaimMix;
  expectedTelemetryShape: ExpectedTelemetryShape;
  successCriteria: SuccessCriteria;
  claims: FixtureClaim[];
  requiredFiles: string[];
  redactionConstraints: RedactionConstraints;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FIXTURES_DIR = "fixtures/concepts";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to a concept fixture directory.
 *
 * @param fixtureId - The fixture identifier (e.g., "low-unknown", "high-unknown")
 * @returns Absolute path to the fixture directory
 * @throws Error if fixture directory doesn't exist
 */
export function getFixturePath(fixtureId: string): string {
  const harnessDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(harnessDir, FIXTURES_DIR, fixtureId);

  if (!existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixtureId} (expected at ${fixturePath})`);
  }

  return fixturePath;
}

/**
 * Load a concept fixture into a target directory.
 *
 * Reads the fixture manifest, recursively copies the fixture's state tree
 * into the target base directory, and returns the parsed manifest.
 *
 * @param fixtureId - The fixture identifier (e.g., "low-unknown", "high-unknown")
 * @param targetBase - Absolute path to the target directory for state tree copy
 * @returns The parsed fixture manifest
 * @throws Error if fixture or manifest not found
 */
export function loadFixture(fixtureId: string, targetBase: string): FixtureManifest {
  const fixturePath = getFixturePath(fixtureId);
  const manifestPath = join(fixturePath, "FIXTURE-MANIFEST.json");

  // Read and parse manifest
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found for fixture ${fixtureId}: ${manifestPath}`);
  }

  const manifestRaw = readFileSync(manifestPath, "utf-8");
  const manifest: FixtureManifest = JSON.parse(manifestRaw);

  // Validate manifest has required fields
  validateManifest(manifest, fixtureId);

  // Copy state tree if it exists
  const statePath = join(fixturePath, "state");
  if (existsSync(statePath)) {
    cpSync(statePath, join(targetBase, "state"), { recursive: true });
  }

  return manifest;
}

/**
 * Read and parse a fixture manifest without copying state.
 *
 * @param fixtureId - The fixture identifier
 * @returns The parsed fixture manifest
 * @throws Error if fixture or manifest not found
 */
export function readFixtureManifest(fixtureId: string): FixtureManifest {
  const fixturePath = getFixturePath(fixtureId);
  const manifestPath = join(fixturePath, "FIXTURE-MANIFEST.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found for fixture ${fixtureId}: ${manifestPath}`);
  }

  const manifestRaw = readFileSync(manifestPath, "utf-8");
  const manifest: FixtureManifest = JSON.parse(manifestRaw);

  validateManifest(manifest, fixtureId);

  return manifest;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof FixtureManifest)[] = [
  "id",
  "scenarioDescription",
  "claimMix",
  "expectedTelemetryShape",
  "successCriteria",
  "claims",
  "requiredFiles",
];

/**
 * Validation result for fixture state integrity check.
 */
export interface FixtureStateValidation {
  valid: boolean;
  missingFiles: string[];
}

/**
 * Validate that all required files from a fixture manifest exist in the target state tree.
 *
 * After loadFixture copies the state/ tree into targetBase/state/, this function
 * checks that each entry in manifest.requiredFiles exists at the expected path.
 *
 * @param manifest - The fixture manifest to validate against
 * @param targetBase - The target base directory containing the copied state tree
 * @returns Validation result with valid status and list of missing files
 */
export function validateFixtureState(
  manifest: FixtureManifest,
  targetBase: string
): FixtureStateValidation {
  const missingFiles: string[] = [];

  for (const requiredFile of manifest.requiredFiles) {
    // requiredFiles entries are relative paths like "state/slices/S01/factcheck/..."
    // The target has state/ copied to targetBase/state/
    const fullPath = join(targetBase, requiredFile);

    if (!existsSync(fullPath)) {
      missingFiles.push(requiredFile);
    }
  }

  return {
    valid: missingFiles.length === 0,
    missingFiles,
  };
}

function validateManifest(manifest: FixtureManifest, fixtureId: string): void {
  const missing = REQUIRED_FIELDS.filter((field) => !(field in manifest));

  if (missing.length > 0) {
    throw new Error(
      `Invalid manifest for fixture ${fixtureId}: missing fields [${missing.join(", ")}]`
    );
  }

  // Validate claim IDs are unique
  const claimIds = new Set<string>();
  for (const claim of manifest.claims) {
    if (claimIds.has(claim.claimId)) {
      throw new Error(
        `Invalid manifest for fixture ${fixtureId}: duplicate claimId ${claim.claimId}`
      );
    }
    claimIds.add(claim.claimId);
  }

  // Validate claimMix matches claims array
  const { claimMix } = manifest;
  if (claimMix.total !== manifest.claims.length) {
    throw new Error(
      `Invalid manifest for fixture ${fixtureId}: claimMix.total (${claimMix.total}) ` +
        `does not match claims array length (${manifest.claims.length})`
    );
  }
}
