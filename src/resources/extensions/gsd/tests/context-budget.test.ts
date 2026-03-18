/**
 * Unit tests for context-budget.ts — the budget engine.
 * Tests pure functions with dependency-injected fakes.
 * No I/O, no extension context, no global state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type BudgetAllocation,
  type MinimalModel,
  type MinimalModelRegistry,
  type MinimalPreferences,
  type TruncationResult,
  computeBudgets,
  truncateAtSectionBoundary,
  resolveExecutorContextWindow,
} from "../context-budget.js";

import type { TokenProvider } from "../token-counter.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRegistry(models: MinimalModel[]): MinimalModelRegistry {
  return { getAll: () => models };
}

function makeModel(id: string, provider: string, contextWindow: number): MinimalModel {
  return { id, provider, contextWindow };
}

// ─── computeBudgets ──────────────────────────────────────────────────────────

describe("context-budget: computeBudgets", () => {
  it("returns proportional allocations for 128K context window", () => {
    const b = computeBudgets(128_000);
    // 128K tokens × 4 chars/token = 512K chars total
    assert.equal(b.summaryBudgetChars, Math.floor(512_000 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(512_000 * 0.40));
    assert.equal(b.verificationBudgetChars, Math.floor(512_000 * 0.10));
    assert.equal(b.continueThresholdPercent, 70);
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 5);
  });

  it("returns proportional allocations for 200K context window", () => {
    const b = computeBudgets(200_000);
    // 200K tokens × 4 = 800K chars
    assert.equal(b.summaryBudgetChars, Math.floor(800_000 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(800_000 * 0.40));
    assert.equal(b.verificationBudgetChars, Math.floor(800_000 * 0.10));
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 6);
  });

  it("returns proportional allocations for 1M context window", () => {
    const b = computeBudgets(1_000_000);
    // 1M tokens × 4 = 4M chars
    assert.equal(b.summaryBudgetChars, Math.floor(4_000_000 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(4_000_000 * 0.40));
    assert.equal(b.verificationBudgetChars, Math.floor(4_000_000 * 0.10));
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 8);
  });

  it("scales proportionally — 1M > 200K > 128K for all budget fields", () => {
    const b128 = computeBudgets(128_000);
    const b200 = computeBudgets(200_000);
    const b1M = computeBudgets(1_000_000);

    assert.ok(b1M.summaryBudgetChars > b200.summaryBudgetChars);
    assert.ok(b200.summaryBudgetChars > b128.summaryBudgetChars);

    assert.ok(b1M.inlineContextBudgetChars > b200.inlineContextBudgetChars);
    assert.ok(b200.inlineContextBudgetChars > b128.inlineContextBudgetChars);

    assert.ok(b1M.verificationBudgetChars > b200.verificationBudgetChars);
    assert.ok(b200.verificationBudgetChars > b128.verificationBudgetChars);

    assert.ok(b1M.taskCountRange.max >= b200.taskCountRange.max);
    assert.ok(b200.taskCountRange.max >= b128.taskCountRange.max);
  });

  it("enforces task count floor (min ≥ 2) at all sizes", () => {
    for (const size of [128_000, 200_000, 1_000_000, 50_000]) {
      const b = computeBudgets(size);
      assert.ok(b.taskCountRange.min >= 2, `min should be ≥ 2 at ${size}, got ${b.taskCountRange.min}`);
    }
  });

  it("task count ceiling exists and is bounded", () => {
    const b = computeBudgets(10_000_000); // very large window
    assert.ok(b.taskCountRange.max <= 8, `max should be capped, got ${b.taskCountRange.max}`);
    assert.ok(b.taskCountRange.max >= b.taskCountRange.min);
  });

  it("handles zero input gracefully — defaults to 200K", () => {
    const b = computeBudgets(0);
    const b200 = computeBudgets(200_000);
    assert.deepStrictEqual(b, b200);
  });

  it("handles negative input gracefully — defaults to 200K", () => {
    const b = computeBudgets(-100);
    const b200 = computeBudgets(200_000);
    assert.deepStrictEqual(b, b200);
  });
});

// ─── truncateAtSectionBoundary ───────────────────────────────────────────────

describe("context-budget: truncateAtSectionBoundary", () => {
  it("returns content unchanged when under budget", () => {
    const content = "### Section 1\nSome text.\n\n### Section 2\nMore text.";
    const result = truncateAtSectionBoundary(content, 10_000);
    assert.equal(result.content, content);
    assert.equal(result.droppedSections, 0);
  });

  it("returns empty string unchanged", () => {
    const result = truncateAtSectionBoundary("", 100);
    assert.equal(result.content, "");
    assert.equal(result.droppedSections, 0);
  });

  it("truncates at section boundary with ### markers", () => {
    const content = [
      "### Section A\nContent A is here.\n",
      "### Section B\nContent B is here.\n",
      "### Section C\nContent C is here.\n",
    ].join("");

    // Budget enough for section A only
    const sectionALen = "### Section A\nContent A is here.\n".length;
    const result = truncateAtSectionBoundary(content, sectionALen + 5);

    assert.ok(result.content.includes("### Section A"), "should keep section A");
    assert.ok(result.content.includes("Content A"), "should keep section A content");
    assert.ok(!result.content.includes("### Section C"), "should drop section C");
    assert.ok(result.content.includes("[...truncated"), "should include truncation indicator");
    // Verify truncation count
    assert.ok(result.content.includes("truncated 2 sections"), `should show 2 truncated, got: ${result.content}`);
    assert.equal(result.droppedSections, 2);
  });

  it("truncates at --- divider boundaries", () => {
    const content = "Intro text.\n\n---\n\nMiddle section.\n\n---\n\nFinal section.";
    // Budget enough for intro only
    const result = truncateAtSectionBoundary(content, 20);

    assert.ok(result.content.includes("Intro text"), "should keep intro");
    assert.ok(result.content.includes("[...truncated"), "should include truncation indicator");
    assert.ok(result.droppedSections > 0, "should report dropped sections");
  });

  it("handles content with no section markers — keeps as much as fits", () => {
    const content = "A".repeat(200);
    const result = truncateAtSectionBoundary(content, 50);

    assert.ok(result.content.length < 200, "should be shorter than original");
    assert.ok(result.content.includes("[...truncated 1 sections]"), "should indicate truncation");
    assert.ok(result.content.startsWith("AAAA"), "should keep content from the start");
    assert.equal(result.droppedSections, 1);
  });

  it("handles content at exact boundary — returns unchanged", () => {
    const content = "### Section 1\nText here.";
    const result = truncateAtSectionBoundary(content, content.length);
    assert.equal(result.content, content);
    assert.equal(result.droppedSections, 0);
  });

  it("always keeps at least the first section even if it exceeds budget", () => {
    const content = "### Long Section\n" + "X".repeat(500) + "\n\n### Short\nY";
    const result = truncateAtSectionBoundary(content, 10);

    // First section should be present even though it exceeds budget
    assert.ok(result.content.includes("### Long Section"), "should keep first section");
    assert.ok(result.content.includes("[...truncated 1 sections]"), "should indicate remaining sections dropped");
    assert.equal(result.droppedSections, 1);
  });
});

// ─── resolveExecutorContextWindow ────────────────────────────────────────────

describe("context-budget: resolveExecutorContextWindow", () => {
  it("returns configured executor model's contextWindow when found", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 200_000),
      makeModel("claude-sonnet-4-20250514", "anthropic", 200_000),
      makeModel("gpt-4o", "openai", 128_000),
    ]);
    const prefs: MinimalPreferences = {
      models: { execution: "gpt-4o" },
    };

    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 128_000);
  });

  it("supports provider/model format in preferences", () => {
    const registry = makeRegistry([
      makeModel("gpt-4o", "openai", 128_000),
      makeModel("gpt-4o", "azure", 64_000),
    ]);
    const prefs: MinimalPreferences = {
      models: { execution: "azure/gpt-4o" },
    };

    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 64_000);
  });

  it("supports object format preferences with model + fallbacks", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 200_000),
    ]);
    const prefs: MinimalPreferences = {
      models: { execution: { model: "claude-opus-4-6", fallbacks: ["gpt-4o"] } },
    };

    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 200_000);
  });

  it("falls back to sessionContextWindow when executor model not found", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 200_000),
    ]);
    const prefs: MinimalPreferences = {
      models: { execution: "nonexistent-model" },
    };

    const result = resolveExecutorContextWindow(registry, prefs, 300_000);
    assert.equal(result, 300_000);
  });

  it("falls back to sessionContextWindow when no execution preference set", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 200_000),
    ]);
    const prefs: MinimalPreferences = { models: {} };

    const result = resolveExecutorContextWindow(registry, prefs, 128_000);
    assert.equal(result, 128_000);
  });

  it("falls back to 200K when no session and no executor model", () => {
    const registry = makeRegistry([]);
    const prefs: MinimalPreferences = { models: { execution: "missing" } };

    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 200_000);
  });

  it("falls back to 200K with undefined preferences", () => {
    const result = resolveExecutorContextWindow(undefined, undefined);
    assert.equal(result, 200_000);
  });

  it("falls back to 200K with undefined registry", () => {
    const prefs: MinimalPreferences = { models: { execution: "claude-opus-4-6" } };
    const result = resolveExecutorContextWindow(undefined, prefs);
    assert.equal(result, 200_000);
  });

  it("ignores models with contextWindow ≤ 0", () => {
    const registry = makeRegistry([
      makeModel("broken-model", "test", 0),
    ]);
    const prefs: MinimalPreferences = { models: { execution: "broken-model" } };

    const result = resolveExecutorContextWindow(registry, prefs, 128_000);
    assert.equal(result, 128_000); // falls through to session
  });

  it("ignores sessionContextWindow ≤ 0", () => {
    const registry = makeRegistry([]);
    const prefs: MinimalPreferences = {};

    const result = resolveExecutorContextWindow(registry, prefs, -1);
    assert.equal(result, 200_000); // falls through to default
  });
});

// ─── computeBudgets with provider ─────────────────────────────────────────────

describe("context-budget: computeBudgets with provider", () => {
  it("anthropic budgets differ from default budgets for same window", () => {
    const defaultBudgets = computeBudgets(200_000);
    const anthropicBudgets = computeBudgets(200_000, "anthropic");

    // anthropic uses 3.5 chars/token vs default 4.0
    // so anthropic totalChars = 200K * 3.5 = 700K vs default 200K * 4 = 800K
    assert.ok(
      anthropicBudgets.summaryBudgetChars < defaultBudgets.summaryBudgetChars,
      `anthropic summary (${anthropicBudgets.summaryBudgetChars}) should be less than default (${defaultBudgets.summaryBudgetChars})`,
    );
    assert.ok(
      anthropicBudgets.inlineContextBudgetChars < defaultBudgets.inlineContextBudgetChars,
      `anthropic inline (${anthropicBudgets.inlineContextBudgetChars}) should be less than default (${defaultBudgets.inlineContextBudgetChars})`,
    );
  });

  it("openai provider matches default budgets (both use 4.0 chars/token)", () => {
    const defaultBudgets = computeBudgets(128_000);
    const openaiBudgets = computeBudgets(128_000, "openai");

    assert.deepStrictEqual(openaiBudgets, defaultBudgets);
  });

  it("anthropic budgets are proportional to 3.5 chars/token", () => {
    const b = computeBudgets(200_000, "anthropic");
    // 200K tokens * 3.5 chars/token = 700K chars total
    assert.equal(b.summaryBudgetChars, Math.floor(700_000 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(700_000 * 0.40));
    assert.equal(b.verificationBudgetChars, Math.floor(700_000 * 0.10));
  });

  it("bedrock budgets match anthropic (both use 3.5 chars/token)", () => {
    const anthropicBudgets = computeBudgets(200_000, "anthropic");
    const bedrockBudgets = computeBudgets(200_000, "bedrock");

    assert.deepStrictEqual(bedrockBudgets, anthropicBudgets);
  });

  it("default behavior unchanged when no provider is passed", () => {
    const b = computeBudgets(128_000);
    // 128K * 4 = 512K
    assert.equal(b.summaryBudgetChars, Math.floor(512_000 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(512_000 * 0.40));
    assert.equal(b.verificationBudgetChars, Math.floor(512_000 * 0.10));
    assert.equal(b.continueThresholdPercent, 70);
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 5);
  });

  it("task count range is unaffected by provider", () => {
    const defaultBudgets = computeBudgets(200_000);
    const anthropicBudgets = computeBudgets(200_000, "anthropic");

    assert.deepStrictEqual(anthropicBudgets.taskCountRange, defaultBudgets.taskCountRange);
    assert.equal(anthropicBudgets.continueThresholdPercent, defaultBudgets.continueThresholdPercent);
  });

  it("handles zero input with provider — defaults to 200K", () => {
    const b = computeBudgets(0, "anthropic");
    const b200 = computeBudgets(200_000, "anthropic");
    assert.deepStrictEqual(b, b200);
  });
});
