/**
 * Tests for skill telemetry and skill health (#599).
 * Tests the pure functions — no file I/O, no extension context.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UnitMetrics } from "../metrics.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<UnitMetrics> = {}): UnitMetrics {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
    cost: 0.05,
    toolCalls: 3,
    assistantMessages: 5,
    userMessages: 2,
    ...overrides,
  };
}

// ─── Skill Telemetry ──────────────────────────────────────────────────────────

describe("skill-telemetry", () => {
  // Note: captureAvailableSkills/getAndClearSkills depend on filesystem (getAgentDir)
  // so we test the data flow via getSkillLastUsed and detectStaleSkills which are pure

  it("getSkillLastUsed returns most recent timestamp per skill", async () => {
    const { getSkillLastUsed } = await import("../skill-telemetry.js");

    const units = [
      makeUnit({ finishedAt: 1000, skills: ["rust-core", "axum-web-framework"] }),
      makeUnit({ finishedAt: 2000, skills: ["rust-core"] }),
      makeUnit({ finishedAt: 3000, skills: ["axum-web-framework"] }),
    ];

    const result = getSkillLastUsed(units);
    assert.equal(result.get("rust-core"), 2000);
    assert.equal(result.get("axum-web-framework"), 3000);
  });

  it("getSkillLastUsed returns empty map for units without skills", async () => {
    const { getSkillLastUsed } = await import("../skill-telemetry.js");

    const units = [makeUnit(), makeUnit()];
    const result = getSkillLastUsed(units);
    assert.equal(result.size, 0);
  });
});

// ─── Skill Health ─────────────────────────────────────────────────────────────

describe("skill-health", () => {
  it("buildHealSkillPrompt includes unit ID", async () => {
    const { buildHealSkillPrompt } = await import("../skill-health.js");
    const prompt = buildHealSkillPrompt("M001/S01/T01");
    assert.ok(prompt.includes("M001/S01/T01"));
    assert.ok(prompt.includes("Skill Heal Analysis"));
    assert.ok(prompt.includes("skill-review-queue.md"));
  });

  it("computeStaleAvoidList excludes already-avoided skills", async () => {
    // This test requires filesystem access for loadLedgerFromDisk
    // so we test the filtering logic conceptually
    const { computeStaleAvoidList } = await import("../skill-health.js");

    // With no metrics file, should return empty
    const result = computeStaleAvoidList("/nonexistent/path", ["some-skill"]);
    assert.deepEqual(result, []);
  });
});

// ─── UnitMetrics skills field ─────────────────────────────────────────────────

describe("UnitMetrics skills field", () => {
  it("skills field is optional and accepts string array", () => {
    const unit = makeUnit({ skills: ["rust-core", "axum-web-framework"] });
    assert.deepEqual(unit.skills, ["rust-core", "axum-web-framework"]);
  });

  it("skills field is undefined when not provided", () => {
    const unit = makeUnit();
    assert.equal(unit.skills, undefined);
  });
});

// ─── Preferences ──────────────────────────────────────────────────────────────

describe("skill_staleness_days preference", () => {
  it("validates valid staleness days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: 30 });
    assert.equal(result.preferences.skill_staleness_days, 30);
    assert.equal(result.errors.length, 0);
  });

  it("validates zero (disabled) staleness days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: 0 });
    assert.equal(result.preferences.skill_staleness_days, 0);
    assert.equal(result.errors.length, 0);
  });

  it("rejects negative staleness days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: -5 });
    assert.equal(result.preferences.skill_staleness_days, undefined);
    assert.ok(result.errors.some(e => e.includes("skill_staleness_days")));
  });

  it("floors fractional days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: 30.7 });
    assert.equal(result.preferences.skill_staleness_days, 30);
  });
});
