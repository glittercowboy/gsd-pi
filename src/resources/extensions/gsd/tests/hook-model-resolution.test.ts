/**
 * Tests for hook model resolution (#1720).
 *
 * Verifies that resolveModelId handles all model ID formats correctly,
 * including OpenRouter-style "org/model" IDs, provider-prefixed IDs,
 * and bare IDs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveModelId } from "../auto-model-selection.js";

// ─── Test Models ─────────────────────────────────────────────────────────────

type TestModel = { id: string; provider: string };

const AVAILABLE_MODELS: TestModel[] = [
  { id: "claude-sonnet-4-6", provider: "anthropic" },
  { id: "claude-opus-4-6", provider: "anthropic" },
  { id: "claude-haiku-4-5", provider: "anthropic" },
  { id: "openai/gpt-5.4-codex", provider: "openrouter" },
  { id: "google/gemini-2.5-pro", provider: "openrouter" },
  { id: "gpt-4o", provider: "openai" },
  { id: "gpt-4o", provider: "azure" },
];

// ─── Bare model ID ───────────────────────────────────────────────────────────

test("resolveModelId: bare ID resolves to current provider first", () => {
  const match = resolveModelId("gpt-4o", AVAILABLE_MODELS, "openai");
  assert.ok(match);
  assert.equal(match.provider, "openai");
  assert.equal(match.id, "gpt-4o");
});

test("resolveModelId: bare ID falls back to first available when no current provider match", () => {
  const match = resolveModelId("claude-sonnet-4-6", AVAILABLE_MODELS, "openai");
  assert.ok(match);
  assert.equal(match.provider, "anthropic");
  assert.equal(match.id, "claude-sonnet-4-6");
});

// ─── Provider-prefixed ID ────────────────────────────────────────────────────

test("resolveModelId: provider/model resolves correctly", () => {
  const match = resolveModelId("anthropic/claude-opus-4-6", AVAILABLE_MODELS, undefined);
  assert.ok(match);
  assert.equal(match.provider, "anthropic");
  assert.equal(match.id, "claude-opus-4-6");
});

test("resolveModelId: provider/model case-insensitive", () => {
  const match = resolveModelId("Anthropic/Claude-Sonnet-4-6", AVAILABLE_MODELS, undefined);
  assert.ok(match);
  assert.equal(match.provider, "anthropic");
});

// ─── OpenRouter-style model IDs (org/model as the ID) ───────────────────────

test("resolveModelId: openrouter/org/model resolves full string as ID", () => {
  const match = resolveModelId("openrouter/openai/gpt-5.4-codex", AVAILABLE_MODELS, undefined);
  assert.ok(match, "should find the OpenRouter model with org/model ID");
  assert.equal(match.provider, "openrouter");
  assert.equal(match.id, "openai/gpt-5.4-codex");
});

test("resolveModelId: openrouter org/model resolves when used as bare ID", () => {
  // When the user specifies "openai/gpt-5.4-codex" without provider prefix,
  // and "openai" is not a known provider, it should try matching the full
  // string as a model ID.
  const modelsWithoutOpenai = AVAILABLE_MODELS.filter(m => m.provider !== "openai" && m.provider !== "azure");
  const match = resolveModelId("openai/gpt-5.4-codex", modelsWithoutOpenai, undefined);
  assert.ok(match, "should find the model when openai is not a known provider");
  assert.equal(match.provider, "openrouter");
  assert.equal(match.id, "openai/gpt-5.4-codex");
});

// ─── Disambiguation with multiple providers ──────────────────────────────────

test("resolveModelId: azure/gpt-4o resolves to azure provider", () => {
  const match = resolveModelId("azure/gpt-4o", AVAILABLE_MODELS, undefined);
  assert.ok(match);
  assert.equal(match.provider, "azure");
  assert.equal(match.id, "gpt-4o");
});

// ─── Missing model ───────────────────────────────────────────────────────────

test("resolveModelId: returns undefined for unknown model", () => {
  const match = resolveModelId("nonexistent-model", AVAILABLE_MODELS, "anthropic");
  assert.equal(match, undefined);
});

test("resolveModelId: returns undefined for unknown provider/model combo", () => {
  const match = resolveModelId("fakeprovider/fake-model", AVAILABLE_MODELS, undefined);
  assert.equal(match, undefined);
});
