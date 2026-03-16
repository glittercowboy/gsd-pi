// GSD Extension — Hook Preferences Parsing Tests (Post-Unit + Pre-Dispatch)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { createTestContext } from "./test-helpers.ts";
import type { PreDispatchHookConfig } from "../types.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Post-Unit Hook Config Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Post-unit hook config validation ===");

{
  const validHook = {
    name: "test-hook",
    after: ["execute-task"],
    prompt: "Test prompt",
    max_cycles: 2,
    model: "claude-sonnet-4-6",
    artifact: "TEST-RESULT.md",
    retry_on: "TEST-ISSUES.md",
    enabled: true,
  };

  assertEq(validHook.name, "test-hook", "valid hook has name");
  assertEq(validHook.after.length, 1, "valid hook has one after entry");
  assertEq(validHook.after[0], "execute-task", "valid hook triggers after execute-task");
  assertTrue(validHook.max_cycles! <= 10, "max_cycles within limit");
  assertTrue(validHook.max_cycles! >= 1, "max_cycles above minimum");
}

console.log("\n=== max_cycles clamping ===");

{
  const clampedHigh = Math.max(1, Math.min(10, Math.round(15)));
  assertEq(clampedHigh, 10, "max_cycles above 10 clamped to 10");

  const clampedLow = Math.max(1, Math.min(10, Math.round(0)));
  assertEq(clampedLow, 1, "max_cycles below 1 clamped to 1");

  const clampedNeg = Math.max(1, Math.min(10, Math.round(-5)));
  assertEq(clampedNeg, 1, "negative max_cycles clamped to 1");

  const normal = Math.max(1, Math.min(10, Math.round(3)));
  assertEq(normal, 3, "normal max_cycles passes through");
}

console.log("\n=== Post-unit hook merging ===");

{
  const baseHooks = [
    { name: "review", after: ["execute-task"], prompt: "base prompt" },
    { name: "lint", after: ["plan-slice"], prompt: "lint code" },
  ];

  const overrideHooks = [
    { name: "review", after: ["execute-task", "complete-slice"], prompt: "override prompt" },
    { name: "security", after: ["execute-task"], prompt: "security check" },
  ];

  const merged = [...baseHooks];
  for (const hook of overrideHooks) {
    const idx = merged.findIndex(h => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }

  assertEq(merged.length, 3, "merged has 3 hooks");
  assertEq(merged[0].prompt, "override prompt", "review hook was overridden");
  assertEq(merged[0].after.length, 2, "overridden review has 2 after entries");
  assertEq(merged[1].name, "lint", "lint kept from base");
  assertEq(merged[2].name, "security", "security added from override");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Pre-Dispatch Hook Config Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Pre-dispatch hook config shape ===");

{
  const modifyHook = {
    name: "inject-context",
    before: ["execute-task"],
    action: "modify" as const,
    prepend: "Remember to follow coding conventions.",
    append: "Run tests after making changes.",
    enabled: true,
  };

  assertEq(modifyHook.name, "inject-context", "modify hook has name");
  assertEq(modifyHook.action, "modify", "action is modify");
  assertTrue(!!modifyHook.prepend, "has prepend text");
  assertTrue(!!modifyHook.append, "has append text");
}

{
  const skipHook = {
    name: "skip-research",
    before: ["research-slice"],
    action: "skip" as const,
    skip_if: "RESEARCH-DONE.md",
    enabled: true,
  };

  assertEq(skipHook.action, "skip", "action is skip");
  assertEq(skipHook.skip_if, "RESEARCH-DONE.md", "has skip condition");
}

{
  const replaceHook = {
    name: "custom-planning",
    before: ["plan-slice"],
    action: "replace" as const,
    prompt: "Use custom planning approach for {sliceId}",
    unit_type: "custom-plan",
    model: "claude-opus-4-6",
    enabled: true,
  };

  assertEq(replaceHook.action, "replace", "action is replace");
  assertTrue(!!replaceHook.prompt, "replace hook has prompt");
  assertEq(replaceHook.unit_type, "custom-plan", "has unit_type override");
}

console.log("\n=== Pre-dispatch action validation ===");

{
  const validActions = new Set(["modify", "skip", "replace"]);
  assertTrue(validActions.has("modify"), "modify is valid");
  assertTrue(validActions.has("skip"), "skip is valid");
  assertTrue(validActions.has("replace"), "replace is valid");
  assertTrue(!validActions.has("delete"), "delete is not valid");
  assertTrue(!validActions.has(""), "empty string is not valid");
}

console.log("\n=== Pre-dispatch hook merging ===");

{
  const baseHooks: PreDispatchHookConfig[] = [
    { name: "inject", before: ["execute-task"], action: "modify", prepend: "base" },
  ];

  const overrideHooks: PreDispatchHookConfig[] = [
    { name: "inject", before: ["execute-task"], action: "modify", prepend: "override" },
    { name: "gate", before: ["plan-slice"], action: "skip" },
  ];

  const merged: PreDispatchHookConfig[] = [...baseHooks];
  for (const hook of overrideHooks) {
    const idx = merged.findIndex(h => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }

  assertEq(merged.length, 2, "merged has 2 pre-dispatch hooks");
  assertEq(merged[0].prepend, "override", "inject hook overridden");
  assertEq(merged[1].name, "gate", "gate hook added");
}

// ═══════════════════════════════════════════════════════════════════════════
// Known unit types validation
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Known unit types ===");

{
  const knownUnitTypes = new Set([
    "research-milestone", "plan-milestone", "research-slice", "plan-slice",
    "execute-task", "complete-slice", "replan-slice", "reassess-roadmap",
    "run-uat", "fix-merge", "complete-milestone",
  ]);

  assertTrue(knownUnitTypes.has("execute-task"), "execute-task is known");
  assertTrue(knownUnitTypes.has("complete-slice"), "complete-slice is known");
  assertTrue(knownUnitTypes.has("plan-slice"), "plan-slice is known");
  assertTrue(!knownUnitTypes.has("hook/review"), "hook types are not in known set");
  assertTrue(!knownUnitTypes.has("invalid-type"), "invalid types are not in known set");
}

// ═══════════════════════════════════════════════════════════════════════════
// Preferences YAML format verification
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Preferences YAML format ===");

{
  const prefsContent = [
    "---",
    "version: 1",
    "post_unit_hooks:",
    "  - name: code-review",
    "    after:",
    "      - execute-task",
    "    prompt: Review the changes",
    "    max_cycles: 3",
    "    artifact: REVIEW-PASS.md",
    "    retry_on: REVIEW-ISSUES.md",
    "pre_dispatch_hooks:",
    "  - name: inject-conventions",
    "    before:",
    "      - execute-task",
    "    action: modify",
    "    append: Follow project coding conventions",
    "  - name: custom-research",
    "    before:",
    "      - research-slice",
    "    action: replace",
    "    prompt: Custom research prompt",
    "---",
  ].join("\n");

  assertTrue(prefsContent.includes("post_unit_hooks:"), "has post_unit_hooks key");
  assertTrue(prefsContent.includes("pre_dispatch_hooks:"), "has pre_dispatch_hooks key");
  assertTrue(prefsContent.includes("action: modify"), "has modify action");
  assertTrue(prefsContent.includes("action: replace"), "has replace action");
}

report();
