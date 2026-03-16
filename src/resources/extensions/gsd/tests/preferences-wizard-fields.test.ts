/**
 * preferences-wizard-fields.test.ts — Validates that all wizard-configurable
 * preference fields are properly validated and round-trip through the schema.
 */

import { createTestContext } from "./test-helpers.ts";
import { validatePreferences } from "../preferences.ts";
import type { GSDPreferences } from "../preferences.ts";

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {
  console.log("\n=== budget fields validate correctly ===");

  {
    const { preferences, errors } = validatePreferences({
      budget_ceiling: 25.50,
      budget_enforcement: "warn",
      context_pause_threshold: 80,
    });
    assertEq(errors.length, 0, "valid budget fields produce no errors");
    assertEq(preferences.budget_ceiling, 25.50, "budget_ceiling passes through");
    assertEq(preferences.budget_enforcement, "warn", "budget_enforcement passes through");
    assertEq(preferences.context_pause_threshold, 80, "context_pause_threshold passes through");
  }

  {
    const { preferences, errors } = validatePreferences({
      budget_enforcement: "pause",
    });
    assertEq(errors.length, 0, "budget_enforcement 'pause' is valid");
    assertEq(preferences.budget_enforcement, "pause", "pause passes through");
  }

  {
    const { preferences, errors } = validatePreferences({
      budget_enforcement: "halt",
    });
    assertEq(errors.length, 0, "budget_enforcement 'halt' is valid");
    assertEq(preferences.budget_enforcement, "halt", "halt passes through");
  }

  {
    const { errors } = validatePreferences({
      budget_enforcement: "invalid",
    } as unknown as GSDPreferences);
    assertTrue(errors.some(e => e.includes("budget_enforcement")), "invalid budget_enforcement rejected");
  }

  console.log("\n=== notification fields validate correctly ===");

  {
    const { preferences, errors } = validatePreferences({
      notifications: {
        enabled: true,
        on_complete: false,
        on_error: true,
        on_budget: true,
        on_milestone: false,
        on_attention: true,
      },
    });
    assertEq(errors.length, 0, "valid notifications produce no errors");
    assertEq(preferences.notifications?.enabled, true, "notifications.enabled passes through");
    assertEq(preferences.notifications?.on_complete, false, "notifications.on_complete passes through");
    assertEq(preferences.notifications?.on_milestone, false, "notifications.on_milestone passes through");
  }

  {
    const { errors } = validatePreferences({
      notifications: "invalid",
    } as unknown as GSDPreferences);
    assertTrue(errors.some(e => e.includes("notifications")), "invalid notifications rejected");
  }

  console.log("\n=== git fields validate correctly ===");

  {
    const { preferences, errors } = validatePreferences({
      git: {
        auto_push: true,
        push_branches: false,
        remote: "upstream",
        snapshots: true,
        pre_merge_check: "auto",
        commit_type: "feat",
        main_branch: "develop",
        merge_strategy: "squash",
        isolation: "branch",
      },
    });
    assertEq(errors.length, 0, "valid git fields produce no errors");
    assertEq(preferences.git?.auto_push, true, "git.auto_push passes through");
    assertEq(preferences.git?.push_branches, false, "git.push_branches passes through");
    assertEq(preferences.git?.remote, "upstream", "git.remote passes through");
    assertEq(preferences.git?.snapshots, true, "git.snapshots passes through");
    assertEq(preferences.git?.pre_merge_check, "auto", "git.pre_merge_check passes through");
    assertEq(preferences.git?.commit_type, "feat", "git.commit_type passes through");
    assertEq(preferences.git?.main_branch, "develop", "git.main_branch passes through");
    assertEq(preferences.git?.merge_strategy, "squash", "git.merge_strategy passes through");
    assertEq(preferences.git?.isolation, "branch", "git.isolation passes through");
  }

  console.log("\n=== uat_dispatch validates correctly ===");

  {
    const { preferences, errors } = validatePreferences({ uat_dispatch: true });
    assertEq(errors.length, 0, "valid uat_dispatch produces no errors");
    assertEq(preferences.uat_dispatch, true, "uat_dispatch true passes through");
  }

  {
    const { preferences, errors } = validatePreferences({ uat_dispatch: false });
    assertEq(errors.length, 0, "valid uat_dispatch false produces no errors");
    assertEq(preferences.uat_dispatch, false, "uat_dispatch false passes through");
  }

  console.log("\n=== unique_milestone_ids validates correctly ===");

  {
    const { preferences, errors } = validatePreferences({ unique_milestone_ids: true });
    assertEq(errors.length, 0, "valid unique_milestone_ids produces no errors");
    assertEq(preferences.unique_milestone_ids, true, "unique_milestone_ids passes through");
  }

  console.log("\n=== all wizard fields together produce no errors ===");

  {
    const fullPrefs: GSDPreferences = {
      version: 1,
      models: { research: "claude-opus-4-6", planning: "claude-sonnet-4-6" },
      auto_supervisor: { soft_timeout_minutes: 15, idle_timeout_minutes: 5, hard_timeout_minutes: 25 },
      git: {
        main_branch: "main",
        auto_push: true,
        push_branches: false,
        remote: "origin",
        snapshots: true,
        pre_merge_check: "auto",
        commit_type: "feat",
        merge_strategy: "squash",
        isolation: "worktree",
      },
      skill_discovery: "suggest",
      unique_milestone_ids: false,
      budget_ceiling: 50,
      budget_enforcement: "pause",
      context_pause_threshold: 75,
      notifications: {
        enabled: true,
        on_complete: true,
        on_error: true,
        on_budget: true,
        on_milestone: true,
        on_attention: true,
      },
      uat_dispatch: false,
    };
    const { errors, warnings } = validatePreferences(fullPrefs);
    const unknownWarnings = warnings.filter(w => w.includes("unknown"));
    assertEq(errors.length, 0, "full wizard prefs produce no errors");
    assertEq(unknownWarnings.length, 0, "full wizard prefs produce no unknown-key warnings");
  }

  report();
}

main();
