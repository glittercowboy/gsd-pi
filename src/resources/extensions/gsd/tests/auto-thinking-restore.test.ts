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
  assert.ok(
    hookBlock.includes("pi.setThinkingLevel(s.autoModeStartThinkingLevel)"),
    "hook model override should re-apply captured thinking level after setModel",
  );
});
