/**
 * preferences-schema-validation.test.ts — Validates that schema validation
 * detects unknown keys, invalid types, and surfaces warnings correctly.
 */

import { createTestContext } from "./test-helpers.ts";
import { validatePreferences } from "../preferences.ts";
import type { GSDPreferences } from "../preferences.ts";

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {
  console.log("\n=== unknown keys produce warnings ===");

  {
    const prefs = { typo_key: "value" } as unknown as GSDPreferences;
    const { warnings } = validatePreferences(prefs);
    assertTrue(warnings.some(w => w.includes("typo_key")), "unknown key 'typo_key' produces warning");
    assertTrue(warnings.some(w => w.includes("unknown")), "warning mentions 'unknown'");
  }

  {
    const prefs = { foo: 1, bar: 2 } as unknown as GSDPreferences;
    const { warnings } = validatePreferences(prefs);
    assertTrue(warnings.some(w => w.includes("foo")), "unknown key 'foo' produces warning");
    assertTrue(warnings.some(w => w.includes("bar")), "unknown key 'bar' produces warning");
    assertEq(warnings.filter(w => w.includes("unknown")).length, 2, "two unknown key warnings");
  }

  console.log("\n=== known keys do NOT produce unknown-key warnings ===");

  {
    const prefs: GSDPreferences = {
      version: 1,
      uat_dispatch: true,
      budget_ceiling: 50,
      skill_discovery: "auto",
    };
    const { warnings } = validatePreferences(prefs);
    const unknownWarnings = warnings.filter(w => w.includes("unknown"));
    assertEq(unknownWarnings.length, 0, "valid keys produce no unknown-key warnings");
  }

  console.log("\n=== all GSDPreferences keys are accepted ===");

  {
    const prefs: GSDPreferences = {
      version: 1,
      always_use_skills: ["skill-a"],
      prefer_skills: ["skill-b"],
      avoid_skills: ["skill-c"],
      skill_rules: [{ when: "testing", use: ["skill-d"] }],
      custom_instructions: ["do a thing"],
      models: { research: "claude-opus-4-6" },
      skill_discovery: "suggest",
      auto_supervisor: { model: "claude-opus-4-6" },
      uat_dispatch: false,
      unique_milestone_ids: true,
      budget_ceiling: 100,
      budget_enforcement: "warn",
      context_pause_threshold: 0.8,
      notifications: { enabled: true },
      remote_questions: { channel: "slack", channel_id: "C123" },
      git: { auto_push: true },
      post_unit_hooks: [{ name: "test-hook", after: ["execute-task"], prompt: "do it" }],
      pre_dispatch_hooks: [{ name: "pre-hook", before: ["execute-task"], action: "skip" }],
    };
    const { warnings } = validatePreferences(prefs);
    const unknownWarnings = warnings.filter(w => w.includes("unknown"));
    assertEq(unknownWarnings.length, 0, "all known keys produce no unknown-key warnings");
  }

  console.log("\n=== invalid value types produce errors ===");

  {
    const prefs = { budget_ceiling: "not-a-number" } as unknown as GSDPreferences;
    const { errors, preferences } = validatePreferences(prefs);
    assertTrue(errors.some(e => e.includes("budget_ceiling")), "invalid budget_ceiling produces error");
    assertEq(preferences.budget_ceiling, undefined, "invalid budget_ceiling falls back to undefined");
  }

  {
    const prefs = { budget_enforcement: "invalid" } as unknown as GSDPreferences;
    const { errors, preferences } = validatePreferences(prefs);
    assertTrue(errors.some(e => e.includes("budget_enforcement")), "invalid budget_enforcement produces error");
    assertEq(preferences.budget_enforcement, undefined, "invalid budget_enforcement falls back to undefined");
  }

  {
    const prefs = { context_pause_threshold: "not-a-number" } as unknown as GSDPreferences;
    const { errors, preferences } = validatePreferences(prefs);
    assertTrue(errors.some(e => e.includes("context_pause_threshold")), "invalid context_pause_threshold produces error");
    assertEq(preferences.context_pause_threshold, undefined, "invalid context_pause_threshold falls back to undefined");
  }

  {
    const prefs = { skill_discovery: "invalid-mode" } as unknown as GSDPreferences;
    const { errors, preferences } = validatePreferences(prefs);
    assertTrue(errors.some(e => e.includes("skill_discovery")), "invalid skill_discovery produces error");
    assertEq(preferences.skill_discovery, undefined, "invalid skill_discovery falls back to undefined");
  }

  console.log("\n=== valid values pass through correctly ===");

  {
    const { preferences } = validatePreferences({ budget_enforcement: "halt" });
    assertEq(preferences.budget_enforcement, "halt", "valid budget_enforcement passes through");
  }

  {
    const { preferences } = validatePreferences({ context_pause_threshold: 0.75 });
    assertEq(preferences.context_pause_threshold, 0.75, "valid context_pause_threshold passes through");
  }

  {
    const { preferences } = validatePreferences({ models: { research: "claude-opus-4-6" } });
    assertEq(preferences.models?.research, "claude-opus-4-6", "valid models passes through");
  }

  {
    const { preferences } = validatePreferences({ auto_supervisor: { model: "claude-opus-4-6" } });
    assertEq(preferences.auto_supervisor?.model, "claude-opus-4-6", "valid auto_supervisor passes through");
  }

  {
    const { preferences } = validatePreferences({ notifications: { enabled: true } });
    assertEq(preferences.notifications?.enabled, true, "valid notifications passes through");
  }

  {
    const { preferences } = validatePreferences({ remote_questions: { channel: "slack", channel_id: "C123" } });
    assertEq(preferences.remote_questions?.channel, "slack", "valid remote_questions passes through");
  }

  console.log("\n=== mixed valid/invalid/unknown keys ===");

  {
    const prefs = {
      uat_dispatch: true,
      totally_made_up: "value",
      budget_ceiling: "garbage",
    } as unknown as GSDPreferences;
    const { preferences, errors, warnings } = validatePreferences(prefs);

    // Valid key works
    assertEq(preferences.uat_dispatch, true, "valid uat_dispatch preserved");

    // Unknown key warned
    assertTrue(warnings.some(w => w.includes("totally_made_up")), "unknown key warned");

    // Invalid value errored and dropped
    assertTrue(errors.some(e => e.includes("budget_ceiling")), "invalid budget_ceiling errored");
    assertEq(preferences.budget_ceiling, undefined, "invalid budget_ceiling dropped");
  }

  console.log("\n=== existing behavior preserved ===");

  // git.isolation is a valid active setting (worktree | branch) — no warnings or errors
  {
    const { warnings, errors, preferences } = validatePreferences({ git: { isolation: "worktree" } } as GSDPreferences);
    const unknownWarnings = warnings.filter(w => w.includes("unknown"));
    assertEq(unknownWarnings.length, 0, "git is a known key — no unknown-key warning");
    assertEq(errors.length, 0, "valid git.isolation produces no errors");
    assertEq(preferences.git?.isolation, "worktree", "git.isolation value passes through");
  }

  // git.merge_to_main is deprecated — still produces deprecation warning
  {
    const { warnings } = validatePreferences({ git: { merge_to_main: true } } as GSDPreferences);
    assertTrue(warnings.some(w => w.includes("deprecated")), "deprecated git.merge_to_main still warns");
  }

  report();
}

main();
