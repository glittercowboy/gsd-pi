import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSourceRegion } from "./test-helpers.ts";

const autoSrc = readFileSync(join(import.meta.dirname, "..", "auto.ts"), "utf-8");
const phasesSrc = readFileSync(join(import.meta.dirname, "..", "auto", "phases.ts"), "utf-8");

test("stopAuto restores original thinking level", () => {
  assert.ok(
    autoSrc.includes("if (pi && s.originalThinkingLevel)"),
    "auto.ts should conditionally restore original thinking level in stopAuto",
  );
  assert.ok(
    autoSrc.includes("pi.setThinkingLevel(s.originalThinkingLevel)"),
    "auto.ts should call pi.setThinkingLevel with originalThinkingLevel",
  );
});

test("runUnitPhase threads captured thinking level into selectAndApplyModel", () => {
  const callIdx = phasesSrc.indexOf("deps.selectAndApplyModel(");
  assert.ok(callIdx > -1, "phases.ts should call selectAndApplyModel");
  const callBlock = extractSourceRegion(phasesSrc, "deps.selectAndApplyModel(");
  assert.ok(
    callBlock.includes("s.autoModeStartThinkingLevel"),
    "runUnitPhase should pass autoModeStartThinkingLevel to selectAndApplyModel",
  );
});

test("hook model override preserves captured thinking level", () => {
  const hookIdx = phasesSrc.indexOf("const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;");
  assert.ok(hookIdx > -1, "phases.ts should include hook model override handling");
  const hookBlock = extractSourceRegion(phasesSrc, "const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;");
  // After thinking_policy was wired, the hook block routes through
  // resolveThinkingLevel so the policy-resolved level (or the start snapshot
  // when no policy is configured) is re-applied — not the raw start level
  // unconditionally. Both branches still ultimately call pi.setThinkingLevel.
  assert.ok(
    hookBlock.includes("pi.setThinkingLevel("),
    "hook model override should re-apply a thinking level after setModel",
  );
  assert.ok(
    hookBlock.includes("s.autoModeStartThinkingLevel"),
    "hook model override should reference the captured start-level snapshot (as fallback)",
  );
  assert.ok(
    hookBlock.includes("getEffectiveThinkingLevel"),
    "hook model override should consult thinking_policy via getEffectiveThinkingLevel",
  );
});
