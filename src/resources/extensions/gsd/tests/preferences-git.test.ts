// GSD Git Preferences Tests — validates git.isolation and git.merge_to_main handling
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { createTestContext } from "./test-helpers.ts";
import { validatePreferences } from "../preferences.ts";

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {
  console.log("\n=== git.isolation ===");

  // Valid values are accepted without warnings
  {
    const { preferences, warnings, errors } = validatePreferences({ git: { isolation: "worktree" } });
    assertEq(errors.length, 0, "isolation: worktree — no errors");
    assertEq(warnings.length, 0, "isolation: worktree — no warnings");
    assertEq(preferences.git?.isolation, "worktree", "isolation: worktree — value preserved");
  }
  {
    const { preferences, warnings, errors } = validatePreferences({ git: { isolation: "branch" } });
    assertEq(errors.length, 0, "isolation: branch — no errors");
    assertEq(warnings.length, 0, "isolation: branch — no warnings");
    assertEq(preferences.git?.isolation, "branch", "isolation: branch — value preserved");
  }

  // Invalid values produce errors
  {
    const { errors } = validatePreferences({ git: { isolation: "invalid" as any } });
    assertTrue(errors.length > 0, "isolation: invalid — produces error");
    assertTrue(errors[0].includes("worktree, branch"), "isolation: invalid — error mentions valid values");
  }

  // Undefined passes through without warning
  {
    const { preferences, warnings } = validatePreferences({ git: { auto_push: true } });
    assertEq(warnings.length, 0, "isolation: undefined — no warnings");
    assertEq(preferences.git?.isolation, undefined, "isolation: undefined — not set");
  }

  console.log("\n=== git.merge_to_main deprecated ===");

  // Any value produces a deprecation warning
  {
    const { warnings } = validatePreferences({ git: { merge_to_main: "milestone" } as any });
    assertTrue(warnings.length > 0, "merge_to_main: milestone — produces deprecation warning");
    assertTrue(warnings[0].includes("deprecated"), "merge_to_main: milestone — warning mentions deprecated");
  }
  {
    const { warnings } = validatePreferences({ git: { merge_to_main: "slice" } as any });
    assertTrue(warnings.length > 0, "merge_to_main: slice — produces deprecation warning");
    assertTrue(warnings[0].includes("deprecated"), "merge_to_main: slice — warning mentions deprecated");
  }

  // Undefined passes through without warning
  {
    const { preferences, warnings } = validatePreferences({ git: { auto_push: true } });
    assertEq(warnings.length, 0, "merge_to_main: undefined — no warnings");
    assertEq((preferences.git as any)?.merge_to_main, undefined, "merge_to_main: undefined — not set");
  }

  console.log("\n=== isolation + deprecated merge_to_main together ===");
  {
    const { warnings, errors } = validatePreferences({
      git: { isolation: "branch", merge_to_main: "slice" } as any,
    });
    assertEq(errors.length, 0, "branch isolation + deprecated merge_to_main — no errors");
    assertEq(warnings.length, 1, "branch isolation + deprecated merge_to_main — 1 warning (merge_to_main only)");
    assertTrue(warnings[0].includes("merge_to_main"), "warning mentions merge_to_main");
  }

  report();
}

main();
