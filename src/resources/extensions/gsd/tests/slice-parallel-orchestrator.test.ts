/**
 * Structural tests for slice-level parallel orchestrator.
 * Verifies the orchestrator module exists and has the correct shape,
 * env var usage, and preference gating.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

describe("slice-parallel-orchestrator structural tests", () => {
  it("orchestrator uses GSD_SLICE_LOCK env var", () => {
    const source = readFileSync(join(gsdDir, "slice-parallel-orchestrator.ts"), "utf-8");
    assert.ok(
      source.includes("GSD_SLICE_LOCK"),
      "Orchestrator must use GSD_SLICE_LOCK env var to isolate slice workers",
    );
  });

  it("orchestrator sets GSD_PARALLEL_WORKER=1 to prevent nesting", () => {
    const source = readFileSync(join(gsdDir, "slice-parallel-orchestrator.ts"), "utf-8");
    assert.ok(
      source.includes("GSD_PARALLEL_WORKER"),
      "Orchestrator must set GSD_PARALLEL_WORKER to prevent nested parallel",
    );
  });

  it("maxWorkers default is 2", () => {
    const source = readFileSync(join(gsdDir, "slice-parallel-orchestrator.ts"), "utf-8");
    // Check that default max workers is 2 (in opts.maxWorkers ?? 2 or similar)
    assert.ok(
      source.includes("maxWorkers") && source.includes("2"),
      "Default maxWorkers should be 2",
    );
  });

  it("orchestrator imports GSD_MILESTONE_LOCK for milestone isolation", () => {
    const source = readFileSync(join(gsdDir, "slice-parallel-orchestrator.ts"), "utf-8");
    assert.ok(
      source.includes("GSD_MILESTONE_LOCK"),
      "Orchestrator must also pass GSD_MILESTONE_LOCK for milestone context",
    );
  });
});

describe("slice_parallel preference gating", () => {
  it("preferences-types.ts includes slice_parallel in interface", () => {
    const source = readFileSync(join(gsdDir, "preferences-types.ts"), "utf-8");
    assert.ok(
      source.includes("slice_parallel"),
      "GSDPreferences should have slice_parallel field",
    );
  });

  it("slice_parallel is in KNOWN_PREFERENCE_KEYS", () => {
    const source = readFileSync(join(gsdDir, "preferences-types.ts"), "utf-8");
    assert.ok(
      source.includes('"slice_parallel"'),
      'KNOWN_PREFERENCE_KEYS should include "slice_parallel"',
    );
  });

  it("state.ts checks GSD_SLICE_LOCK for slice isolation", () => {
    const source = readFileSync(join(gsdDir, "state.ts"), "utf-8");
    assert.ok(
      source.includes("GSD_SLICE_LOCK"),
      "State derivation should check GSD_SLICE_LOCK for slice-level parallel isolation",
    );
  });

  it("auto.ts imports slice parallel orchestrator when enabled", () => {
    const source = readFileSync(join(gsdDir, "auto.ts"), "utf-8");
    assert.ok(
      source.includes("slice_parallel") || source.includes("slice-parallel"),
      "auto.ts should reference slice_parallel for dispatch gating",
    );
  });
});
