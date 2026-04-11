// GSD Extension — Interactive Routing Bypass Tests
// Verifies that dynamic routing is skipped for interactive (guided-flow) dispatches
// and that model downgrade notifications always fire (#3962).
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Source-level structural tests ──────────────────────────────────────────

const modelSelectionSrc = readFileSync(
  join(__dirname, "..", "auto-model-selection.ts"),
  "utf-8",
);

const guidedFlowSrc = readFileSync(
  join(__dirname, "..", "guided-flow.ts"),
  "utf-8",
);

const autoStartSrc = readFileSync(
  join(__dirname, "..", "auto-start.ts"),
  "utf-8",
);

describe("interactive routing bypass (#3962)", () => {
  test("selectAndApplyModel accepts isAutoMode parameter", () => {
    // The function signature should include isAutoMode with a default of true
    assert.ok(
      modelSelectionSrc.includes("isAutoMode"),
      "selectAndApplyModel should have isAutoMode parameter",
    );
    assert.ok(
      modelSelectionSrc.includes("isAutoMode = true"),
      "isAutoMode should default to true (auto-mode behavior preserved)",
    );
  });

  test("routing is disabled when isAutoMode is false", () => {
    // The code should disable routing when not in auto-mode
    assert.ok(
      modelSelectionSrc.includes("if (!isAutoMode)"),
      "should check isAutoMode flag to disable routing",
    );
    assert.ok(
      modelSelectionSrc.includes("routingConfig.enabled = false"),
      "should set routingConfig.enabled = false for interactive mode",
    );
  });

  test("resolvePreferredModelConfig skips routing synthesis when isAutoMode is false", () => {
    // resolvePreferredModelConfig should accept isAutoMode and bail early
    // before synthesizing a routing ceiling from tier_models (#3962 codex review)
    assert.ok(
      modelSelectionSrc.includes("function resolvePreferredModelConfig"),
      "resolvePreferredModelConfig should exist",
    );
    // The function should check isAutoMode before routing synthesis
    const fnIdx = modelSelectionSrc.indexOf("function resolvePreferredModelConfig");
    const fnBody = modelSelectionSrc.slice(fnIdx, fnIdx + 600);
    assert.ok(
      fnBody.includes("isAutoMode"),
      "resolvePreferredModelConfig should accept isAutoMode parameter",
    );
    assert.ok(
      fnBody.includes("if (!isAutoMode) return undefined"),
      "should return undefined (skip routing synthesis) when not in auto-mode",
    );
  });

  test("selectAndApplyModel threads isAutoMode to resolvePreferredModelConfig", () => {
    // The call to resolvePreferredModelConfig inside selectAndApplyModel
    // should pass isAutoMode as the third argument
    const callSite = "resolvePreferredModelConfig(unitType, autoModeStartModel, isAutoMode)";
    assert.ok(
      modelSelectionSrc.includes(callSite),
      "selectAndApplyModel should pass isAutoMode to resolvePreferredModelConfig",
    );
  });

  test("guided-flow passes isAutoMode=false", () => {
    // guided-flow.ts should explicitly pass isAutoMode as false
    assert.ok(
      guidedFlowSrc.includes("/* isAutoMode */ false"),
      "guided-flow should pass isAutoMode=false to selectAndApplyModel",
    );
  });

  test("auto/phases.ts does NOT pass isAutoMode=false", () => {
    // auto/phases.ts should use the default (true) — it's auto-mode
    const phasesSrc = readFileSync(
      join(__dirname, "..", "auto", "phases.ts"),
      "utf-8",
    );
    assert.ok(
      !phasesSrc.includes("isAutoMode"),
      "auto/phases.ts should use default isAutoMode=true (not pass it explicitly)",
    );
  });
});

describe("model downgrade notifications always visible (#3962)", () => {
  test("downgrade notification is not gated by verbose flag", () => {
    // The downgrade notification block should NOT be wrapped in `if (verbose)`
    // Find the downgrade block and verify it's not behind a verbose check
    const downgradeBlock = "if (routingResult.wasDowngraded)";
    const downgradeIdx = modelSelectionSrc.indexOf(downgradeBlock);
    assert.ok(downgradeIdx > 0, "downgrade block should exist");

    // Extract the code between wasDowngraded check and the next routing label assignment
    const afterDowngrade = modelSelectionSrc.slice(
      downgradeIdx,
      modelSelectionSrc.indexOf("routingTierLabel =", downgradeIdx),
    );

    // The notification calls should NOT be wrapped in `if (verbose)`
    assert.ok(
      !afterDowngrade.includes("if (verbose)"),
      "downgrade notifications should not be gated by verbose flag",
    );

    // But the notification calls should exist
    assert.ok(
      afterDowngrade.includes('ctx.ui.notify('),
      "downgrade notifications should still fire",
    );
  });

  test("tier escalation notification is not gated by verbose flag", () => {
    // Extract the escalation block: from "if (escalated)" to its closing
    // and verify the notification is present but `if (verbose)` is not.
    const escalatedIdx = modelSelectionSrc.indexOf("if (escalated)");
    assert.ok(escalatedIdx > 0, "escalation block should exist");

    // Get the block from "if (escalated)" to the next closing brace pattern
    const block = modelSelectionSrc.slice(escalatedIdx, escalatedIdx + 400);
    assert.ok(
      block.includes("Tier escalation:"),
      "escalation block should contain the notification",
    );
    assert.ok(
      !block.includes("if (verbose)"),
      "escalation block should not gate notification behind verbose flag",
    );
  });
});

describe("auto-mode start routing banner (#3962)", () => {
  test("auto-start shows dynamic routing status on startup", () => {
    assert.ok(
      autoStartSrc.includes("Dynamic routing:"),
      "auto-start should display routing status banner",
    );
    assert.ok(
      autoStartSrc.includes("resolveDynamicRoutingConfig"),
      "auto-start should import resolveDynamicRoutingConfig",
    );
  });

  test("banner shows different messages for enabled vs disabled routing", () => {
    assert.ok(
      autoStartSrc.includes("Dynamic routing: enabled"),
      "should show message when routing is enabled",
    );
    assert.ok(
      autoStartSrc.includes("Dynamic routing: disabled"),
      "should show message when routing is disabled",
    );
  });

  test("banner shows the ceiling model", () => {
    assert.ok(
      autoStartSrc.includes("startModelLabel"),
      "banner should reference the start/ceiling model",
    );
  });

  test("banner accounts for flat-rate provider suppression", () => {
    // The banner should check isFlatRateProvider to accurately reflect
    // whether routing will actually be active at dispatch time (#3962 codex review)
    assert.ok(
      autoStartSrc.includes("isFlatRateProvider"),
      "banner should check flat-rate provider status",
    );
    assert.ok(
      autoStartSrc.includes("effectivelyEnabled"),
      "banner should compute effective routing state, not just raw config",
    );
  });

  test("banner uses effective ceiling from tier_models.heavy when configured", () => {
    // The actual ceiling may come from tier_models.heavy, not the start model
    assert.ok(
      autoStartSrc.includes("tier_models?.heavy"),
      "banner should check tier_models.heavy for the effective ceiling",
    );
    assert.ok(
      autoStartSrc.includes("effectiveCeiling"),
      "banner should compute the effective ceiling model",
    );
  });
});
