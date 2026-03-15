/**
 * preferences-git.test.ts — Validates that deprecated git.isolation and
 * git.merge_to_main preference fields produce deprecation warnings.
 */

import { createTestContext } from "./test-helpers.ts";
import { validatePreferences } from "../preferences.ts";

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {
  console.log("\n=== git.isolation deprecated ===");

  // Any value produces a deprecation warning
  {
    const { warnings } = validatePreferences({ git: { isolation: "worktree" } });
    assertTrue(warnings.length > 0, "isolation: worktree — produces deprecation warning");
    assertTrue(warnings[0].includes("deprecated"), "isolation: worktree — warning mentions deprecated");
  }
  {
    const { warnings } = validatePreferences({ git: { isolation: "branch" } });
    assertTrue(warnings.length > 0, "isolation: branch — produces deprecation warning");
    assertTrue(warnings[0].includes("deprecated"), "isolation: branch — warning mentions deprecated");
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
    const { warnings } = validatePreferences({ git: { merge_to_main: "milestone" } });
    assertTrue(warnings.length > 0, "merge_to_main: milestone — produces deprecation warning");
    assertTrue(warnings[0].includes("deprecated"), "merge_to_main: milestone — warning mentions deprecated");
  }
  {
    const { warnings } = validatePreferences({ git: { merge_to_main: "slice" } });
    assertTrue(warnings.length > 0, "merge_to_main: slice — produces deprecation warning");
    assertTrue(warnings[0].includes("deprecated"), "merge_to_main: slice — warning mentions deprecated");
  }

  // Undefined passes through without warning
  {
    const { preferences, warnings } = validatePreferences({ git: { auto_push: true } });
    assertEq(warnings.length, 0, "merge_to_main: undefined — no warnings");
    assertEq(preferences.git?.merge_to_main, undefined, "merge_to_main: undefined — not set");
  }

  console.log("\n=== both deprecated fields together ===");
  {
    const { warnings } = validatePreferences({
      git: { isolation: "worktree", merge_to_main: "slice" },
    });
    assertEq(warnings.length, 2, "both deprecated fields — 2 warnings");
    assertTrue(warnings.some(w => w.includes("isolation")), "one warning mentions isolation");
    assertTrue(warnings.some(w => w.includes("merge_to_main")), "one warning mentions merge_to_main");
  }

  report();
}

main();
