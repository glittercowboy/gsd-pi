import test from "node:test";
import assert from "node:assert/strict";

import { lookupModelCost, compareModelCost, BUNDLED_COST_TABLE } from "../model-cost-table.js";

// ─── lookupModelCost ─────────────────────────────────────────────────────────

test("lookupModelCost finds exact match", () => {
  const entry = lookupModelCost("claude-opus-4-6");
  assert.ok(entry);
  assert.equal(entry.id, "claude-opus-4-6");
  assert.ok(entry.inputPer1k > 0);
  assert.ok(entry.outputPer1k > 0);
});

test("lookupModelCost strips provider prefix", () => {
  const entry = lookupModelCost("anthropic/claude-opus-4-6");
  assert.ok(entry);
  assert.equal(entry.id, "claude-opus-4-6");
});

test("lookupModelCost returns undefined for unknown model", () => {
  const entry = lookupModelCost("totally-unknown-model");
  assert.equal(entry, undefined);
});

test("lookupModelCost finds haiku", () => {
  const entry = lookupModelCost("claude-haiku-4-5");
  assert.ok(entry);
  assert.ok(entry.inputPer1k < 0.001, "haiku should be cheap");
});

// ─── compareModelCost ────────────────────────────────────────────────────────

test("haiku is cheaper than opus", () => {
  assert.ok(compareModelCost("claude-haiku-4-5", "claude-opus-4-6") < 0);
});

test("opus is more expensive than sonnet", () => {
  assert.ok(compareModelCost("claude-opus-4-6", "claude-sonnet-4-6") > 0);
});

test("same model has equal cost", () => {
  assert.equal(compareModelCost("claude-opus-4-6", "claude-opus-4-6"), 0);
});

// ─── BUNDLED_COST_TABLE ──────────────────────────────────────────────────────

test("cost table has entries for all major providers", () => {
  const ids = BUNDLED_COST_TABLE.map(e => e.id);
  // Anthropic
  assert.ok(ids.includes("claude-opus-4-6"));
  assert.ok(ids.includes("claude-sonnet-4-6"));
  assert.ok(ids.includes("claude-haiku-4-5"));
  // OpenAI
  assert.ok(ids.includes("gpt-4o"));
  assert.ok(ids.includes("gpt-4o-mini"));
  // Google
  assert.ok(ids.includes("gemini-2.0-flash"));
});

test("all cost table entries have valid data", () => {
  for (const entry of BUNDLED_COST_TABLE) {
    assert.ok(entry.id, `entry missing id`);
    assert.ok(entry.inputPer1k >= 0, `${entry.id} inputPer1k should be >= 0`);
    assert.ok(entry.outputPer1k >= 0, `${entry.id} outputPer1k should be >= 0`);
    assert.ok(entry.updatedAt, `${entry.id} missing updatedAt`);
  }
});

// ─── #2885: openai-codex and modern OpenAI models in cost table ──────────────

test("#2885: cost table includes openai-codex provider models", () => {
  const ids = BUNDLED_COST_TABLE.map(e => e.id);
  const codexModels = [
    "gpt-5.1", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
    "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini",
  ];
  for (const model of codexModels) {
    assert.ok(ids.includes(model), `cost table should include openai-codex model "${model}"`);
  }
});

test("#2885: cost table includes modern OpenAI models", () => {
  const ids = BUNDLED_COST_TABLE.map(e => e.id);
  const newModels = [
    "o4-mini", "o4-mini-deep-research",
    "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro",
  ];
  for (const model of newModels) {
    assert.ok(ids.includes(model), `cost table should include modern OpenAI model "${model}"`);
  }
});

test("#2885: lookupModelCost returns costs for new models (not 999 fallback)", () => {
  const newModels = ["o4-mini", "gpt-4.1", "gpt-5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.1-codex-mini"];
  for (const model of newModels) {
    const entry = lookupModelCost(model);
    assert.ok(entry, `lookupModelCost should find "${model}"`);
    assert.ok(entry.inputPer1k < 999, `${model} should have a real cost, not the 999 fallback`);
  }
});
