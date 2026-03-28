/**
 * Regression tests for completing-milestone dispatch rule:
 * - #2675: must block when VALIDATION verdict is "needs-remediation"
 * - #2931: must tolerate common not-applicable verification_operational phrases
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES } from "../auto-dispatch.ts";
import { openDatabase, insertMilestone, closeDatabase } from "../gsd-db.ts";

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

// ─── #2931: not-applicable verification_operational phrases ───────────────

const NOT_APPLICABLE_PHRASES = [
  "none",
  "None required",
  "N/A",
  "Not applicable",
  "No operational verification required",
  "  none  ",
  "NONE",
];

for (const phrase of NOT_APPLICABLE_PHRASES) {
  test(`completing-milestone dispatches when verification_operational is "${phrase.trim()}" (#2931)`, async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-2931-"));
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

    openDatabase(":memory:");
    try {
      insertMilestone({
        id: "M001",
        title: "Test",
        planning: { verificationOperational: phrase },
      });

      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
        ["---", "verdict: pass", "---", "", "All criteria met."].join("\n"),
      );

      const ctx = {
        mid: "M001",
        midTitle: "Test",
        basePath: base,
        state: { phase: "completing-milestone" } as any,
        prefs: {} as any,
        session: undefined,
      };

      const result = await completingRule!.match(ctx);
      assert.ok(result !== null, "rule should match");
      assert.equal(result!.action, "dispatch", `"${phrase.trim()}" should not block completion`);
    } finally {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("completing-milestone blocks real operational requirement without evidence (#2931)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-2931-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  openDatabase(":memory:");
  try {
    insertMilestone({
      id: "M001",
      title: "Test",
      planning: { verificationOperational: "Load testing under 200ms p99 latency" },
    });

    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      ["---", "verdict: pass", "---", "", "All unit tests pass."].join("\n"),
    );

    const ctx = {
      mid: "M001",
      midTitle: "Test",
      basePath: base,
      state: { phase: "completing-milestone" } as any,
      prefs: {} as any,
      session: undefined,
    };

    const result = await completingRule!.match(ctx);
    assert.ok(result !== null, "rule should match");
    assert.equal(result!.action, "stop", "real operational requirement should block without evidence");
    if (result!.action === "stop") {
      assert.ok(
        result!.reason.includes("operational verification"),
        "reason should mention operational verification",
      );
    }
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("completing-milestone allows real operational requirement with evidence (#2931)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-2931-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  openDatabase(":memory:");
  try {
    insertMilestone({
      id: "M001",
      title: "Test",
      planning: { verificationOperational: "Load testing under 200ms p99 latency" },
    });

    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: pass",
        "---",
        "",
        "## Operational Verification",
        "",
        "Load testing confirmed ✅ — p99 latency 142ms under peak load.",
      ].join("\n"),
    );

    const ctx = {
      mid: "M001",
      midTitle: "Test",
      basePath: base,
      state: { phase: "completing-milestone" } as any,
      prefs: {} as any,
      session: undefined,
    };

    const result = await completingRule!.match(ctx);
    assert.ok(result !== null, "rule should match");
    assert.equal(result!.action, "dispatch", "operational requirement with evidence should dispatch");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
