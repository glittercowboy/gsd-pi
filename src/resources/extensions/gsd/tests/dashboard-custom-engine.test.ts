/**
 * dashboard-custom-engine.test.ts — Tests that the custom engine path
 * calls updateProgressWidget and that unitLabel handles "custom-step".
 *
 * Uses source-level assertions for the non-exported unitLabel function
 * and the updateProgressWidget call placement. Tests exported helpers
 * (unitVerb, unitPhaseLabel) directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unitVerb, unitPhaseLabel } from "../auto-dashboard.js";

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Dashboard custom-engine: unitLabel and related helpers", () => {
  it('unitVerb("custom-step") returns "executing workflow step"', () => {
    assert.equal(unitVerb("custom-step"), "executing workflow step");
  });

  it('unitPhaseLabel("custom-step") returns "WORKFLOW"', () => {
    assert.equal(unitPhaseLabel("custom-step"), "WORKFLOW");
  });

  it('dashboard-overlay.ts contains a case for "custom-step" returning "Workflow Step"', () => {
    const __filename = fileURLToPath(import.meta.url);
    const overlayPath = resolve(__filename, "../../dashboard-overlay.ts");
    const source = readFileSync(overlayPath, "utf-8");
    assert.ok(
      source.includes('"custom-step"') && source.includes('"Workflow Step"'),
      'dashboard-overlay.ts should contain case "custom-step": return "Workflow Step"',
    );
  });
});

describe("Dashboard custom-engine: updateProgressWidget in custom engine path", () => {
  it("loop.ts custom engine path includes updateProgressWidget call before runGuards", () => {
    const __filename = fileURLToPath(import.meta.url);
    const loopPath = resolve(__filename, "../../auto/loop.ts");
    const source = readFileSync(loopPath, "utf-8");

    // Find the custom engine block
    const customEngineStart = source.indexOf('s.activeEngineId !== "dev"');
    assert.ok(customEngineStart > -1, "Should find custom engine path in loop.ts");

    // The updateProgressWidget call should appear after the custom engine block start
    // and before the runGuards call in that block
    const afterCustomEngine = source.slice(customEngineStart);
    const widgetCallIndex = afterCustomEngine.indexOf(
      "deps.updateProgressWidget(ctx, iterData.unitType, iterData.unitId, iterData.state)",
    );
    const guardsCallIndex = afterCustomEngine.indexOf("runGuards(ic,");
    assert.ok(widgetCallIndex > -1, "updateProgressWidget should be called in custom engine path");
    assert.ok(
      widgetCallIndex < guardsCallIndex,
      "updateProgressWidget should be called before runGuards in custom engine path",
    );
  });

  it("updateProgressWidget call is placed after iterData is built", () => {
    const __filename = fileURLToPath(import.meta.url);
    const loopPath = resolve(__filename, "../../auto/loop.ts");
    const source = readFileSync(loopPath, "utf-8");

    const customEngineStart = source.indexOf('s.activeEngineId !== "dev"');
    const afterCustomEngine = source.slice(customEngineStart);

    // Verify custom engine path has iterData built before the widget call
    const iterDataIndex = afterCustomEngine.indexOf("iterData = {");
    const widgetIndex = afterCustomEngine.indexOf("deps.updateProgressWidget");
    assert.ok(iterDataIndex > -1 && widgetIndex > -1, "Both iterData and widget call should exist");
    assert.ok(
      iterDataIndex < widgetIndex,
      "iterData should be built before updateProgressWidget is called",
    );

    // Verify the call uses iterData.state (which holds the derived GSD state)
    assert.ok(
      afterCustomEngine.includes("iterData.state"),
      "Custom engine updateProgressWidget should reference iterData.state",
    );
  });
});
