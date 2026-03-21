/**
 * Regression test for #1919: --fix flag not stripped before positional parse.
 *
 * parseDoctorArgs("--fix") must:
 *   1. Set fixFlag = true
 *   2. Not leak "--fix" into requestedScope
 *   3. Keep mode as "doctor" (the flag is not a positional subcommand)
 */

import { parseDoctorArgs } from "../commands-handlers.js";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {
  // ── 1. Bare --fix flag ──────────────────────────────────────────────────────
  console.log("\n=== bare --fix flag (#1919) ===");
  {
    const r = parseDoctorArgs("--fix");
    assertTrue(r.fixFlag, "--fix sets fixFlag to true");
    assertEq(r.mode, "doctor", "--fix does not change mode from doctor");
    assertEq(r.requestedScope, undefined, "--fix is stripped and does not become requestedScope");
  }

  // ── 2. --fix with a scope ──────────────────────────────────────────────────
  console.log("\n=== --fix with scope ===");
  {
    const r = parseDoctorArgs("--fix M001/S01");
    assertTrue(r.fixFlag, "--fix M001/S01 sets fixFlag to true");
    assertEq(r.mode, "doctor", "--fix M001/S01 keeps mode as doctor");
    assertEq(r.requestedScope, "M001/S01", "scope is M001/S01 after stripping --fix");
  }

  // ── 3. Positional fix still works ──────────────────────────────────────────
  console.log("\n=== positional fix subcommand ===");
  {
    const r = parseDoctorArgs("fix");
    assertEq(r.fixFlag, false, "positional fix does not set fixFlag");
    assertEq(r.mode, "fix", "positional fix sets mode to fix");
    assertEq(r.requestedScope, undefined, "no scope with bare positional fix");
  }

  // ── 4. Positional fix with scope ───────────────────────────────────────────
  console.log("\n=== positional fix with scope ===");
  {
    const r = parseDoctorArgs("fix M001");
    assertEq(r.mode, "fix", "fix M001 sets mode to fix");
    assertEq(r.requestedScope, "M001", "fix M001 parses scope as M001");
  }

  // ── 5. --fix combined with other flags ─────────────────────────────────────
  console.log("\n=== --fix combined with --dry-run ===");
  {
    const r = parseDoctorArgs("--fix --dry-run");
    assertTrue(r.fixFlag, "--fix --dry-run sets fixFlag");
    assertTrue(r.dryRun, "--fix --dry-run sets dryRun");
    assertEq(r.requestedScope, undefined, "no scope leaked from combined flags");
  }

  // ── 6. --fix combined with --json ──────────────────────────────────────────
  console.log("\n=== --fix with --json ===");
  {
    const r = parseDoctorArgs("--fix --json");
    assertTrue(r.fixFlag, "--fix --json sets fixFlag");
    assertTrue(r.jsonMode, "--fix --json sets jsonMode");
    assertEq(r.requestedScope, undefined, "no scope leaked from --fix --json");
  }

  // ── 7. Empty args (baseline) ───────────────────────────────────────────────
  console.log("\n=== empty args baseline ===");
  {
    const r = parseDoctorArgs("");
    assertEq(r.fixFlag, false, "empty args: fixFlag false");
    assertEq(r.mode, "doctor", "empty args: mode is doctor");
    assertEq(r.requestedScope, undefined, "empty args: no scope");
  }

  // ── 8. heal and audit modes unaffected ─────────────────────────────────────
  console.log("\n=== heal and audit modes ===");
  {
    const rh = parseDoctorArgs("heal M001/S01");
    assertEq(rh.mode, "heal", "heal mode parsed correctly");
    assertEq(rh.requestedScope, "M001/S01", "heal scope parsed correctly");

    const ra = parseDoctorArgs("audit");
    assertEq(ra.mode, "audit", "audit mode parsed correctly");
  }

  report();
}

main();
