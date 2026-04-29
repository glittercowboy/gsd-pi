/**
 * Unit tests for the thinking-policy resolver and its validation surface.
 *
 * Resolver tests are dependency-free (resolveThinkingLevel pulls only types).
 * Validation tests exercise the YAML `false` -> "off" coercion and unknown
 * unit-type rejection through validatePreferences.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getEffectiveThinkingLevel, resolveThinkingLevel } from "../thinking-policy.ts";
import type { ThinkingPolicyConfig } from "../preferences-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

test("resolveThinkingLevel: exact unitType match wins over prefix", () => {
  const policy: ThinkingPolicyConfig = {
    default: "medium",
    prefixes: { "execute-": "high" },
    unitTypes: { "execute-task": "off" },
  };
  assert.equal(resolveThinkingLevel("execute-task", policy, "medium"), "off");
});

test("resolveThinkingLevel: longest prefix wins", () => {
  const policy: ThinkingPolicyConfig = {
    default: "low",
    prefixes: {
      "research-": "medium",
      "research-slice-": "high",
    },
  };
  assert.equal(
    resolveThinkingLevel("research-slice-foo", policy, "off"),
    "high",
  );
});

test("resolveThinkingLevel: prefix match beats default", () => {
  const policy: ThinkingPolicyConfig = {
    default: "low",
    prefixes: { "discuss-": "high" },
  };
  assert.equal(resolveThinkingLevel("discuss-slice", policy, "off"), "high");
});

test("resolveThinkingLevel: falls back to policy.default when no match", () => {
  const policy: ThinkingPolicyConfig = {
    default: "medium",
    prefixes: { "research-": "high" },
    unitTypes: { "execute-task": "off" },
  };
  assert.equal(resolveThinkingLevel("plan-slice", policy, "low"), "medium");
});

test("resolveThinkingLevel: falls back to fallback arg when default missing", () => {
  const policy: ThinkingPolicyConfig = {
    prefixes: { "research-": "high" },
  };
  assert.equal(resolveThinkingLevel("plan-slice", policy, "low"), "low");
});

test("resolveThinkingLevel: undefined policy returns fallback", () => {
  assert.equal(resolveThinkingLevel("execute-task", undefined, "medium"), "medium");
});

test("resolveThinkingLevel: empty policy returns fallback", () => {
  assert.equal(resolveThinkingLevel("execute-task", {}, "high"), "high");
});

test("resolveThinkingLevel: prefix non-match falls through to default", () => {
  const policy: ThinkingPolicyConfig = {
    default: "minimal",
    prefixes: { "research-": "high" },
  };
  assert.equal(resolveThinkingLevel("execute-task", policy, "off"), "minimal");
});

// ─── getEffectiveThinkingLevel — dispatch-site convenience wrapper ────

test("getEffectiveThinkingLevel: returns startLevel unchanged when no policy", () => {
  assert.equal(getEffectiveThinkingLevel("execute-task", undefined, "high"), "high");
});

test("getEffectiveThinkingLevel: returns null/undefined startLevel unchanged when no policy", () => {
  assert.equal(getEffectiveThinkingLevel("execute-task", undefined, null), null);
  assert.equal(getEffectiveThinkingLevel("execute-task", undefined, undefined), undefined);
});

test("getEffectiveThinkingLevel: applies policy with startLevel as fallback", () => {
  const policy: ThinkingPolicyConfig = {
    default: "medium",
    unitTypes: { "execute-task": "off" },
  };
  assert.equal(getEffectiveThinkingLevel("execute-task", policy, "high"), "off");
  // No exact / prefix match → falls through to default
  assert.equal(getEffectiveThinkingLevel("complete-slice", policy, "high"), "medium");
});

test("getEffectiveThinkingLevel: defaults fallback to \"medium\" when startLevel is null", () => {
  const policy: ThinkingPolicyConfig = {}; // no rules → fallback wins
  assert.equal(getEffectiveThinkingLevel("complete-slice", policy, null), "medium");
});

// ─── Validation surface ────────────────────────────────────────────────
// These tests exercise the YAML coercion and KNOWN_UNIT_TYPES enforcement
// in preferences-validation.ts. They require the broader preferences
// dependency graph (git-service/yaml etc.); the resolver tests above stay
// dependency-free so they can run as a fast standalone smoke test.

test("validatePreferences: YAML unquoted `off` (boolean false) coerces to \"off\"", async () => {
  const { validatePreferences } = await import("../preferences-validation.ts");
  const { preferences, errors } = validatePreferences({
    thinking_policy: {
      default: false as unknown as "off",
      unitTypes: {
        "execute-task": false as unknown as "off",
      },
      prefixes: {
        "research-": false as unknown as "off",
      },
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(preferences.thinking_policy?.default, "off");
  assert.equal(preferences.thinking_policy?.unitTypes?.["execute-task"], "off");
  assert.equal(preferences.thinking_policy?.prefixes?.["research-"], "off");
});

test("validatePreferences: rejects unknown unit type with helpful message", async () => {
  const { validatePreferences } = await import("../preferences-validation.ts");
  const { errors } = validatePreferences({
    thinking_policy: {
      unitTypes: {
        "bogus-unit": "high",
      },
    },
  });
  assert.ok(
    errors.some((e) => e.includes("bogus-unit") && e.includes("not a known unit type")),
    `expected error mentioning bogus-unit, got: ${JSON.stringify(errors)}`,
  );
});

test("validatePreferences: rejects invalid level value", async () => {
  const { validatePreferences } = await import("../preferences-validation.ts");
  const { errors } = validatePreferences({
    thinking_policy: {
      default: "ultra" as unknown as "high",
    },
  });
  assert.ok(
    errors.some((e) => e.includes("thinking_policy.default")),
    `expected default-level error, got: ${JSON.stringify(errors)}`,
  );
});

test("validatePreferences: rejects array as thinking_policy", async () => {
  const { validatePreferences } = await import("../preferences-validation.ts");
  const { errors } = validatePreferences({
    thinking_policy: [{ default: "high" }] as unknown as Record<string, unknown>,
  });
  assert.ok(
    errors.some((e) => e.toLowerCase().includes("mapping")),
    `expected mapping error for array input, got: ${JSON.stringify(errors)}`,
  );
});

// ─── Auto-mode wiring (source-level checks) ───────────────────────────
// These assert the policy is actually invoked from the dispatch path
// without requiring the full dependency graph at test runtime.

test("auto-model-selection resolves thinking_policy and prefers user start-level as fallback", () => {
  const src = readFileSync(join(gsdDir, "auto-model-selection.ts"), "utf-8");
  assert.ok(
    src.includes('from "./thinking-policy.js"'),
    "auto-model-selection.ts should import the policy resolver",
  );
  assert.ok(
    src.includes("getEffectiveThinkingLevel(unitType, prefs?.thinking_policy"),
    "auto-model-selection.ts should call getEffectiveThinkingLevel(unitType, policy, startLevel)",
  );
  assert.ok(
    src.includes("autoModeStartThinkingLevel"),
    "the call should pass autoModeStartThinkingLevel as the start-level snapshot",
  );
  assert.ok(
    !src.includes("reapplyThinkingLevel(pi, autoModeStartThinkingLevel)"),
    "auto-model-selection.ts should no longer pass autoModeStartThinkingLevel directly to reapply (it now passes effectiveThinkingLevel)",
  );
  assert.ok(
    src.includes("reapplyThinkingLevel(pi, effectiveThinkingLevel)"),
    "reapplyThinkingLevel should be called with the policy-resolved level",
  );
});

test("auto-model-selection skips policy resolution in interactive (non-auto) mode", () => {
  const src = readFileSync(join(gsdDir, "auto-model-selection.ts"), "utf-8");
  // Interactive/guided dispatches must use the user's session level as-is —
  // dynamic routing is already gated this way (#3962); thinking_policy follows
  // the same convention.
  assert.ok(
    src.includes("isAutoMode") &&
      src.includes("getEffectiveThinkingLevel(unitType, prefs?.thinking_policy") &&
      src.includes(": autoModeStartThinkingLevel ?? null"),
    "thinking_policy should be gated on isAutoMode and bypass to the start snapshot in interactive mode",
  );
});

test("validatePreferences: warns when prefix key does not end with '-'", async () => {
  const { validatePreferences } = await import("../preferences-validation.ts");
  const { warnings, preferences } = validatePreferences({
    thinking_policy: {
      prefixes: {
        research: "high",
      },
    },
  });
  assert.ok(
    warnings.some((w) => w.includes("research") && w.includes("does not end with")),
    `expected prefix-convention warning, got: ${JSON.stringify(warnings)}`,
  );
  // Still honoured (warn, not reject)
  assert.equal(preferences.thinking_policy?.prefixes?.["research"], "high");
});
