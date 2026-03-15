/**
 * preferences-git.test.ts — Validates git.isolation and git.merge_to_main preference fields.
 */

import { createTestContext } from "./test-helpers.ts";
import { validatePreferences } from "../preferences.ts";

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {
  console.log("\n=== git.isolation validation ===");

  // Valid values
  {
    const { preferences, errors } = validatePreferences({ git: { isolation: "worktree" } });
    assertEq(errors.length, 0, "isolation: worktree — no errors");
    assertEq(preferences.git?.isolation, "worktree", "isolation: worktree — value preserved");
  }
  {
    const { preferences, errors } = validatePreferences({ git: { isolation: "branch" } });
    assertEq(errors.length, 0, "isolation: branch — no errors");
    assertEq(preferences.git?.isolation, "branch", "isolation: branch — value preserved");
  }

  // Invalid values
  {
    const { errors } = validatePreferences({ git: { isolation: "invalid" } });
    assertTrue(errors.length > 0, "isolation: invalid — produces error");
    assertTrue(errors[0].includes("isolation"), "isolation: invalid — error mentions isolation");
  }
  {
    const { errors } = validatePreferences({ git: { isolation: 42 } });
    assertTrue(errors.length > 0, "isolation: number — produces error");
  }

  // Undefined passes through
  {
    const { preferences, errors } = validatePreferences({ git: { auto_push: true } });
    assertEq(errors.length, 0, "isolation: undefined — no errors");
    assertEq(preferences.git?.isolation, undefined, "isolation: undefined — not set");
  }

  console.log("\n=== git.merge_to_main validation ===");

  // Valid values
  {
    const { preferences, errors } = validatePreferences({ git: { merge_to_main: "milestone" } });
    assertEq(errors.length, 0, "merge_to_main: milestone — no errors");
    assertEq(preferences.git?.merge_to_main, "milestone", "merge_to_main: milestone — value preserved");
  }
  {
    const { preferences, errors } = validatePreferences({ git: { merge_to_main: "slice" } });
    assertEq(errors.length, 0, "merge_to_main: slice — no errors");
    assertEq(preferences.git?.merge_to_main, "slice", "merge_to_main: slice — value preserved");
  }

  // Invalid values
  {
    const { errors } = validatePreferences({ git: { merge_to_main: "invalid" } });
    assertTrue(errors.length > 0, "merge_to_main: invalid — produces error");
    assertTrue(errors[0].includes("merge_to_main"), "merge_to_main: invalid — error mentions merge_to_main");
  }
  {
    const { errors } = validatePreferences({ git: { merge_to_main: false } });
    assertTrue(errors.length > 0, "merge_to_main: boolean — produces error");
  }

  // Undefined passes through
  {
    const { preferences, errors } = validatePreferences({ git: { auto_push: true } });
    assertEq(errors.length, 0, "merge_to_main: undefined — no errors");
    assertEq(preferences.git?.merge_to_main, undefined, "merge_to_main: undefined — not set");
  }

  console.log("\n=== git.deliver validation ===");

  // Valid values
  {
    const { preferences, errors } = validatePreferences({ git: { deliver: "merge" } });
    assertEq(errors.length, 0, "deliver: merge — no errors");
    assertEq(preferences.git?.deliver, "merge", "deliver: merge — value preserved");
  }
  {
    const { preferences, errors } = validatePreferences({ git: { deliver: "branch" } });
    assertEq(errors.length, 0, "deliver: branch — no errors");
    assertEq(preferences.git?.deliver, "branch", "deliver: branch — value preserved");
  }
  {
    const { preferences, errors } = validatePreferences({ git: { deliver: "pr" } });
    assertEq(errors.length, 0, "deliver: pr — no errors");
    assertEq(preferences.git?.deliver, "pr", "deliver: pr — value preserved");
  }

  // Invalid values
  {
    const { errors } = validatePreferences({ git: { deliver: "invalid" } });
    assertTrue(errors.length > 0, "deliver: invalid — produces error");
    assertTrue(errors[0].includes("deliver"), "deliver: invalid — error mentions deliver");
  }
  {
    const { errors } = validatePreferences({ git: { deliver: true } });
    assertTrue(errors.length > 0, "deliver: boolean — produces error");
  }

  // Undefined passes through
  {
    const { preferences, errors } = validatePreferences({ git: { auto_push: true } });
    assertEq(errors.length, 0, "deliver: undefined — no errors");
    assertEq(preferences.git?.deliver, undefined, "deliver: undefined — not set");
  }

  console.log("\n=== both fields together ===");
  {
    const { preferences, errors } = validatePreferences({
      git: { isolation: "worktree", merge_to_main: "slice", deliver: "pr" },
    });
    assertEq(errors.length, 0, "all fields valid — no errors");
    assertEq(preferences.git?.isolation, "worktree", "isolation preserved");
    assertEq(preferences.git?.merge_to_main, "slice", "merge_to_main preserved");
    assertEq(preferences.git?.deliver, "pr", "deliver preserved");
  }

  report();
}

main();
