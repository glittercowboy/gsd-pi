/**
 * Unit tests for prompt-cache-optimizer.ts — cache-aware prompt reordering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type ContentRole,
  type PromptSection,
  classifySection,
  section,
  optimizeForCaching,
  estimateCacheSavings,
  computeCacheHitRate,
} from "../prompt-cache-optimizer.js";

// ─── classifySection ─────────────────────────────────────────────────────────

describe("prompt-cache-optimizer: classifySection", () => {
  it("classifies system-prompt as static", () => {
    assert.equal(classifySection("system-prompt"), "static");
  });

  it("classifies base-instructions as static", () => {
    assert.equal(classifySection("base-instructions"), "static");
  });

  it("classifies executor-constraints as static", () => {
    assert.equal(classifySection("executor-constraints"), "static");
  });

  it("classifies template-* prefixed labels as static", () => {
    assert.equal(classifySection("template-code"), "static");
    assert.equal(classifySection("template-review"), "static");
    assert.equal(classifySection("template-"), "static");
  });

  it("classifies slice-plan as semi-static", () => {
    assert.equal(classifySection("slice-plan"), "semi-static");
  });

  it("classifies decisions as semi-static", () => {
    assert.equal(classifySection("decisions"), "semi-static");
  });

  it("classifies requirements as semi-static", () => {
    assert.equal(classifySection("requirements"), "semi-static");
  });

  it("classifies roadmap as semi-static", () => {
    assert.equal(classifySection("roadmap"), "semi-static");
  });

  it("classifies prior-summaries as semi-static", () => {
    assert.equal(classifySection("prior-summaries"), "semi-static");
  });

  it("classifies project-context as semi-static", () => {
    assert.equal(classifySection("project-context"), "semi-static");
  });

  it("classifies overrides as semi-static", () => {
    assert.equal(classifySection("overrides"), "semi-static");
  });

  it("classifies task-plan as dynamic", () => {
    assert.equal(classifySection("task-plan"), "dynamic");
  });

  it("classifies task-instructions as dynamic", () => {
    assert.equal(classifySection("task-instructions"), "dynamic");
  });

  it("classifies task-context as dynamic", () => {
    assert.equal(classifySection("task-context"), "dynamic");
  });

  it("classifies file-contents as dynamic", () => {
    assert.equal(classifySection("file-contents"), "dynamic");
  });

  it("classifies diff-context as dynamic", () => {
    assert.equal(classifySection("diff-context"), "dynamic");
  });

  it("classifies verification-commands as dynamic", () => {
    assert.equal(classifySection("verification-commands"), "dynamic");
  });

  it("defaults unknown labels to dynamic", () => {
    assert.equal(classifySection("something-unknown"), "dynamic");
    assert.equal(classifySection(""), "dynamic");
    assert.equal(classifySection("random-label"), "dynamic");
  });
});

// ─── section() helper ────────────────────────────────────────────────────────

describe("prompt-cache-optimizer: section()", () => {
  it("auto-classifies based on label", () => {
    const s = section("system-prompt", "You are an assistant.");
    assert.equal(s.label, "system-prompt");
    assert.equal(s.content, "You are an assistant.");
    assert.equal(s.role, "static");
  });

  it("auto-classifies semi-static labels", () => {
    const s = section("slice-plan", "Plan content here.");
    assert.equal(s.role, "semi-static");
  });

  it("auto-classifies dynamic labels", () => {
    const s = section("task-instructions", "Do this task.");
    assert.equal(s.role, "dynamic");
  });

  it("allows manual role override", () => {
    const s = section("unknown-label", "content", "static");
    assert.equal(s.role, "static");
  });

  it("override takes precedence over auto-classification", () => {
    const s = section("system-prompt", "content", "dynamic");
    assert.equal(s.role, "dynamic");
  });
});

// ─── optimizeForCaching ──────────────────────────────────────────────────────

describe("prompt-cache-optimizer: optimizeForCaching", () => {
  it("orders static before semi-static before dynamic", () => {
    const sections: PromptSection[] = [
      { label: "task", content: "DYNAMIC", role: "dynamic" },
      { label: "plan", content: "SEMI", role: "semi-static" },
      { label: "sys", content: "STATIC", role: "static" },
    ];

    const result = optimizeForCaching(sections);
    const parts = result.prompt.split("\n\n");
    assert.equal(parts[0], "STATIC");
    assert.equal(parts[1], "SEMI");
    assert.equal(parts[2], "DYNAMIC");
  });

  it("preserves relative order within the same role group", () => {
    const sections: PromptSection[] = [
      { label: "d1", content: "D-first", role: "dynamic" },
      { label: "d2", content: "D-second", role: "dynamic" },
      { label: "s1", content: "S-first", role: "static" },
      { label: "s2", content: "S-second", role: "static" },
    ];

    const result = optimizeForCaching(sections);
    const parts = result.prompt.split("\n\n");
    assert.equal(parts[0], "S-first");
    assert.equal(parts[1], "S-second");
    assert.equal(parts[2], "D-first");
    assert.equal(parts[3], "D-second");
  });

  it("calculates cacheEfficiency correctly", () => {
    const sections: PromptSection[] = [
      { label: "sys", content: "AAAA", role: "static" },     // 4 chars
      { label: "plan", content: "BBBB", role: "semi-static" }, // 4 chars
      { label: "task", content: "CCCC", role: "dynamic" },    // 4 chars
    ];

    const result = optimizeForCaching(sections);
    // Cacheable prefix = "AAAA" + "\n\n" + "BBBB" = 10 chars
    // Total = "AAAA\n\nBBBB\n\nCCCC" = 16 chars
    assert.equal(result.cacheablePrefixChars, 10);
    assert.equal(result.totalChars, 16);
    assert.ok(Math.abs(result.cacheEfficiency - 10 / 16) < 0.001);
  });

  it("returns correct section counts", () => {
    const sections: PromptSection[] = [
      { label: "a", content: "x", role: "static" },
      { label: "b", content: "y", role: "static" },
      { label: "c", content: "z", role: "semi-static" },
      { label: "d", content: "w", role: "dynamic" },
    ];

    const result = optimizeForCaching(sections);
    assert.deepEqual(result.sectionCounts, {
      static: 2,
      "semi-static": 1,
      dynamic: 1,
    });
  });

  it("handles empty sections array", () => {
    const result = optimizeForCaching([]);
    assert.equal(result.prompt, "");
    assert.equal(result.cacheablePrefixChars, 0);
    assert.equal(result.totalChars, 0);
    assert.equal(result.cacheEfficiency, 0);
    assert.deepEqual(result.sectionCounts, {
      static: 0,
      "semi-static": 0,
      dynamic: 0,
    });
  });

  it("handles only static sections (100% cacheable)", () => {
    const sections: PromptSection[] = [
      { label: "sys", content: "Hello", role: "static" },
    ];

    const result = optimizeForCaching(sections);
    assert.equal(result.cacheEfficiency, 1);
    assert.equal(result.cacheablePrefixChars, result.totalChars);
  });

  it("handles only dynamic sections (0% cacheable)", () => {
    const sections: PromptSection[] = [
      { label: "task", content: "Do something", role: "dynamic" },
    ];

    const result = optimizeForCaching(sections);
    assert.equal(result.cacheablePrefixChars, 0);
    assert.equal(result.cacheEfficiency, 0);
  });
});

// ─── estimateCacheSavings ────────────────────────────────────────────────────

describe("prompt-cache-optimizer: estimateCacheSavings", () => {
  it("returns 90% of cache efficiency for anthropic", () => {
    const result = optimizeForCaching([
      { label: "sys", content: "AAAA", role: "static" },
      { label: "task", content: "CCCC", role: "dynamic" },
    ]);
    // cacheEfficiency = 4 / 10 = 0.4
    const savings = estimateCacheSavings(result, "anthropic");
    assert.ok(Math.abs(savings - result.cacheEfficiency * 0.9) < 0.001);
  });

  it("returns 50% of cache efficiency for openai", () => {
    const result = optimizeForCaching([
      { label: "sys", content: "AAAA", role: "static" },
      { label: "task", content: "CCCC", role: "dynamic" },
    ]);
    const savings = estimateCacheSavings(result, "openai");
    assert.ok(Math.abs(savings - result.cacheEfficiency * 0.5) < 0.001);
  });

  it("returns 0 for other providers", () => {
    const result = optimizeForCaching([
      { label: "sys", content: "AAAA", role: "static" },
    ]);
    assert.equal(estimateCacheSavings(result, "other"), 0);
  });

  it("returns 0 when cache efficiency is 0", () => {
    const result = optimizeForCaching([
      { label: "task", content: "CCCC", role: "dynamic" },
    ]);
    assert.equal(estimateCacheSavings(result, "anthropic"), 0);
    assert.equal(estimateCacheSavings(result, "openai"), 0);
  });
});

// ─── computeCacheHitRate ─────────────────────────────────────────────────────

describe("prompt-cache-optimizer: computeCacheHitRate", () => {
  it("computes hit rate as percentage", () => {
    const rate = computeCacheHitRate({
      cacheRead: 800,
      cacheWrite: 200,
      input: 200,
    });
    // 800 / (800 + 200) * 100 = 80%
    assert.equal(rate, 80);
  });

  it("returns 0 when no cache activity", () => {
    const rate = computeCacheHitRate({
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
    });
    assert.equal(rate, 0);
  });

  it("returns 100 when everything is from cache", () => {
    const rate = computeCacheHitRate({
      cacheRead: 1000,
      cacheWrite: 0,
      input: 0,
    });
    assert.equal(rate, 100);
  });

  it("returns 0 when nothing is from cache", () => {
    const rate = computeCacheHitRate({
      cacheRead: 0,
      cacheWrite: 500,
      input: 1000,
    });
    assert.equal(rate, 0);
  });

  it("ignores cacheWrite in hit rate calculation", () => {
    const rate = computeCacheHitRate({
      cacheRead: 500,
      cacheWrite: 9999,
      input: 500,
    });
    // 500 / (500 + 500) * 100 = 50%
    assert.equal(rate, 50);
  });
});
