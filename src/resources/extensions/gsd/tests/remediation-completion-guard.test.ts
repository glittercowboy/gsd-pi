/**
 * Regression test for #2675: completing-milestone dispatch rule must
 * block completion when VALIDATION verdict is "needs-remediation".
 *
 * Without this guard, needs-remediation + allSlicesDone causes a loop:
 * complete-milestone dispatched → agent refuses (correct) → no SUMMARY
 * → re-dispatch → repeat until stuck detection fires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES, wasValidationSkippedByPreference } from "../auto-dispatch.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";

/** Find the completing-milestone dispatch rule */
const completingRule = DISPATCH_RULES.find(r => r.name === "completing-milestone → complete-milestone");

test("completing-milestone dispatch rule exists", () => {
  assert.ok(completingRule, "rule should exist in DISPATCH_RULES");
});

test("completing-milestone blocks when VALIDATION verdict is needs-remediation (#2675)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-remediation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  try {
    // Write a VALIDATION file with needs-remediation verdict
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: needs-remediation",
        "remediation_round: 0",
        "---",
        "",
        "# Validation Report",
        "",
        "3 success criteria failed. Remediation required.",
      ].join("\n"),
    );

    const ctx = {
      mid: "M001",
      midTitle: "Test Milestone",
      basePath: base,
      state: { phase: "completing-milestone" } as any,
      prefs: {} as any,
      session: undefined,
    };

    const result = await completingRule!.match(ctx);

    assert.ok(result !== null, "rule should match");
    assert.equal(result!.action, "stop", "should return stop action");
    if (result!.action === "stop") {
      assert.equal(result!.level, "warning", "should be warning level (pausable)");
      assert.ok(
        result!.reason.includes("needs-remediation"),
        "reason should mention needs-remediation",
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("completing-milestone proceeds normally when VALIDATION verdict is pass (#2675 guard)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-remediation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  try {
    // Write a VALIDATION file with pass verdict
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: pass",
        "---",
        "",
        "# Validation Report",
        "",
        "All criteria met.",
      ].join("\n"),
    );

    const ctx = {
      mid: "M001",
      midTitle: "Test Milestone",
      basePath: base,
      state: { phase: "completing-milestone" } as any,
      prefs: {} as any,
      session: undefined,
    };

    const result = await completingRule!.match(ctx);

    // Should NOT return a stop — should either dispatch or return stop for
    // a different reason (e.g. missing SUMMARY files, no implementation)
    if (result && result.action === "stop") {
      assert.ok(
        !result.reason.includes("needs-remediation"),
        "pass verdict should NOT trigger the remediation guard",
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("wasValidationSkippedByPreference detects skip_milestone_validation closures", () => {
  const content = [
    "---",
    "verdict: pass",
    "---",
    "",
    "# Milestone Validation (skipped by preference)",
    "",
    "Milestone validation was skipped via `skip_milestone_validation` preference.",
  ].join("\n");

  assert.equal(wasValidationSkippedByPreference(content), true);
});

test("completing-milestone allows skip-by-preference validation with operational requirements", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-skip-validation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, "app.js"), "console.log('impl');\n");

  try {
    assert.ok(openDatabase(join(base, ".gsd", "state.db")), "temp DB should open");
    insertMilestone({
      id: "M001",
      title: "Test Milestone",
      planning: { verificationOperational: "Smoke app startup and runtime behavior" },
    });

    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: pass",
        "remediation_round: 0",
        "---",
        "",
        "# Milestone Validation (skipped by preference)",
        "",
        "Milestone validation was skipped via `skip_milestone_validation` preference.",
      ].join("\n"),
    );

    const ctx = {
      mid: "M001",
      midTitle: "Test Milestone",
      basePath: base,
      state: { phase: "completing-milestone" } as any,
      prefs: {} as any,
      session: undefined,
    };

    const result = await completingRule!.match(ctx);

    assert.ok(result !== null, "rule should match");
    assert.equal(result?.action, "dispatch", "skip-by-preference validation should allow completion dispatch");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
