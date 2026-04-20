/**
 * dashboard-model-label-ordering.test.ts — Regression test for #2899.
 *
 * The dashboard model label was showing the previous unit's model because
 * updateProgressWidget was called before selectAndApplyModel in phases.ts.
 * This test verifies:
 *   1. updateProgressWidget is called AFTER selectAndApplyModel in phases.ts
 *   2. session.ts has a currentDispatchedModelId field
 *   3. auto.ts exposes getCurrentDispatchedModelId in widgetStateAccessors
 *   4. auto-dashboard.ts reads from a dispatched model accessor, not cmdCtx?.model
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, assertMatch, report } = createTestContext();

const phasesPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const sessionPath = join(import.meta.dirname, "..", "auto", "session.ts");
const autoPath = join(import.meta.dirname, "..", "auto.ts");
const dashboardPath = join(import.meta.dirname, "..", "auto-dashboard.ts");

const phasesSrc = readFileSync(phasesPath, "utf-8");
const sessionSrc = readFileSync(sessionPath, "utf-8");
const autoSrc = readFileSync(autoPath, "utf-8");
const dashboardSrc = readFileSync(dashboardPath, "utf-8");

console.log("\n=== #2899: Dashboard model label shows correct (dispatched) model ===");

// ── Test 1: updateProgressWidget is called AFTER selectAndApplyModel ──────

// Find the positions of the calls in the dispatch function body.
// selectAndApplyModel must appear BEFORE updateProgressWidget.
const selectModelPos = phasesSrc.indexOf("deps.selectAndApplyModel(");
const updateWidgetPos = phasesSrc.indexOf("deps.updateProgressWidget(");

assertTrue(
  selectModelPos > 0,
  "phases.ts contains deps.selectAndApplyModel call",
);

assertTrue(
  updateWidgetPos > 0,
  "phases.ts contains deps.updateProgressWidget call",
);

assertTrue(
  selectModelPos < updateWidgetPos,
  `selectAndApplyModel (pos ${selectModelPos}) must be called BEFORE updateProgressWidget (pos ${updateWidgetPos}) — widget needs fresh model`,
);

// ── Test 2: session.ts declares currentDispatchedModelId ──────────────────

assertTrue(
  sessionSrc.includes("currentDispatchedModelId"),
  "session.ts has currentDispatchedModelId field",
);

// ── Test 3: auto.ts exposes getCurrentDispatchedModelId in widgetStateAccessors ──

assertTrue(
  autoSrc.includes("getCurrentDispatchedModelId"),
  "auto.ts exposes getCurrentDispatchedModelId accessor",
);

// Verify it's in the widgetStateAccessors object
const accessorsBlock = autoSrc.slice(
  autoSrc.indexOf("const widgetStateAccessors"),
  autoSrc.indexOf("};", autoSrc.indexOf("const widgetStateAccessors")) + 2,
);

assertTrue(
  accessorsBlock.includes("getCurrentDispatchedModelId"),
  "getCurrentDispatchedModelId is in the widgetStateAccessors object",
);

// ── Test 4: WidgetStateAccessors interface has getCurrentDispatchedModelId ──

assertTrue(
  dashboardSrc.includes("getCurrentDispatchedModelId"),
  "auto-dashboard.ts references getCurrentDispatchedModelId",
);

// The dashboard render closure should NOT read model from cmdCtx?.model for display.
// It should use the accessor for the dispatched model ID.
// Check that the "Model display" section uses the accessor, not cmdCtx?.model directly.
const modelDisplaySection = dashboardSrc.slice(
  dashboardSrc.indexOf("// Model display"),
  dashboardSrc.indexOf("// Model display") + 500,
);

assertTrue(
  modelDisplaySection.includes("getCurrentDispatchedModelId") ||
  modelDisplaySection.includes("getDispatchedModelId"),
  "Model display section reads from dispatched model accessor, not cmdCtx?.model alone",
);

// ── Test 5: currentDispatchedModelId is set after selectAndApplyModel in phases.ts ──

// After selectAndApplyModel returns, phases.ts should store the dispatched model ID
assertTrue(
  phasesSrc.includes("currentDispatchedModelId"),
  "phases.ts stores currentDispatchedModelId after model selection",
);

report();
