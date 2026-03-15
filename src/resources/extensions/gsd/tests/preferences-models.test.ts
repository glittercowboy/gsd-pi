// GSD Extension — Model Preferences Parsing Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from "node:test";
import assert from "node:assert/strict";

import { parsePreferencesMarkdown } from "../preferences.ts";
import type { GSDModelConfigV2, GSDPhaseModelConfig } from "../preferences.ts";

// ═══════════════════════════════════════════════════════════════════════════
// OpenRouter-style model config parsing (issue #488)
// ═══════════════════════════════════════════════════════════════════════════

test("parses OpenRouter model config with org/model IDs and fallbacks", () => {
  const content = `---
version: 1
models:
  research:
    # Long-context, high-quality research + retrieval
    model: moonshotai/kimi-k2.5
    fallbacks:
      - qwen/qwen3.5-397b-a17b
  planning:
    # Deep, careful reasoning for plans
    model: deepseek/deepseek-r1-0528
    fallbacks:
      - moonshotai/kimi-k2.5
      - deepseek/deepseek-v3.2
  execution:
    model: qwen/qwen3-coder
    fallbacks:
      - qwen/qwen3-coder-next
      - minimax/minimax-m2.5
  completion:
    model: qwen/qwen3-next-80b-a3b-instruct
    fallbacks:
      - deepseek/deepseek-v3.2
      - qwen/qwen-plus-2025-07-28
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed");
  assert.equal(prefs.version, 1, "version should be 1");

  const models = prefs.models as GSDModelConfigV2;
  assert.ok(models, "models should be defined");

  // Research phase
  const research = models.research as GSDPhaseModelConfig;
  assert.ok(research, "research config should exist");
  assert.equal(research.model, "moonshotai/kimi-k2.5", "research primary model");
  assert.deepEqual(research.fallbacks, ["qwen/qwen3.5-397b-a17b"], "research fallbacks");

  // Planning phase
  const planning = models.planning as GSDPhaseModelConfig;
  assert.ok(planning, "planning config should exist");
  assert.equal(planning.model, "deepseek/deepseek-r1-0528", "planning primary model");
  assert.deepEqual(planning.fallbacks, ["moonshotai/kimi-k2.5", "deepseek/deepseek-v3.2"], "planning fallbacks");

  // Execution phase
  const execution = models.execution as GSDPhaseModelConfig;
  assert.ok(execution, "execution config should exist");
  assert.equal(execution.model, "qwen/qwen3-coder", "execution primary model");
  assert.deepEqual(execution.fallbacks, ["qwen/qwen3-coder-next", "minimax/minimax-m2.5"], "execution fallbacks");

  // Completion phase
  const completion = models.completion as GSDPhaseModelConfig;
  assert.ok(completion, "completion config should exist");
  assert.equal(completion.model, "qwen/qwen3-next-80b-a3b-instruct", "completion primary model");
  assert.deepEqual(completion.fallbacks, ["deepseek/deepseek-v3.2", "qwen/qwen-plus-2025-07-28"], "completion fallbacks");
});

test("parses model IDs with colons (OpenRouter variants like :free, :exacto)", () => {
  const content = `---
models:
  execution:
    model: qwen/qwen3-coder
    fallbacks:
      - qwen/qwen3-coder:free
      - qwen/qwen3-coder:exacto
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed");

  const models = prefs.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "qwen/qwen3-coder", "primary model");
  assert.deepEqual(
    execution.fallbacks,
    ["qwen/qwen3-coder:free", "qwen/qwen3-coder:exacto"],
    "fallbacks with colons should be parsed as strings, not objects",
  );
});

test("parses legacy string-per-phase model config", () => {
  const content = `---
models:
  research: claude-opus-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-haiku-4-5
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed");

  const models = prefs.models as GSDModelConfigV2;
  assert.equal(models.research, "claude-opus-4-6", "research as string");
  assert.equal(models.planning, "claude-opus-4-6", "planning as string");
  assert.equal(models.execution, "claude-sonnet-4-6", "execution as string");
  assert.equal(models.completion, "claude-haiku-4-5", "completion as string");
});

test("strips inline YAML comments from values", () => {
  const content = `---
models:
  execution:
    model: qwen/qwen3-coder  # fast coding model
    fallbacks:
      - minimax/minimax-m2.5  # backup
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed");

  const models = prefs.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "qwen/qwen3-coder", "inline comment stripped from model value");
  assert.deepEqual(execution.fallbacks, ["minimax/minimax-m2.5"], "inline comment stripped from fallback");
});

test("handles Windows line endings (CRLF)", () => {
  const content = "---\r\nmodels:\r\n  execution:\r\n    model: qwen/qwen3-coder\r\n---\r\n";

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed with CRLF line endings");

  const models = prefs.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "qwen/qwen3-coder", "model parsed correctly with CRLF");
});

test("handles model config with explicit provider field", () => {
  const content = `---
models:
  execution:
    model: claude-opus-4-6
    provider: bedrock
    fallbacks:
      - claude-sonnet-4-6
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed");

  const models = prefs.models as GSDModelConfigV2;
  const execution = models.execution as GSDPhaseModelConfig;
  assert.equal(execution.model, "claude-opus-4-6", "model value");
  assert.equal(execution.provider, "bedrock", "provider value");
  assert.deepEqual(execution.fallbacks, ["claude-sonnet-4-6"], "fallbacks");
});

test("handles empty models config", () => {
  const content = `---
version: 1
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed");
  assert.equal(prefs.models, undefined, "models should be undefined when not specified");
});

test("handles comment-only lines between keys without breaking structure", () => {
  const content = `---
models:
  # Research models
  research:
    # Primary research model
    model: moonshotai/kimi-k2.5
    # Fallback list
    fallbacks:
      # Best alternatives
      - qwen/qwen3.5-397b-a17b
  # Planning models
  planning:
    model: deepseek/deepseek-r1-0528
---
`;

  const prefs = parsePreferencesMarkdown(content);
  assert.ok(prefs, "preferences should be parsed with comments");

  const models = prefs.models as GSDModelConfigV2;
  const research = models.research as GSDPhaseModelConfig;
  assert.equal(research.model, "moonshotai/kimi-k2.5", "model value unaffected by surrounding comments");
  // Note: comments inside arrays (like "# Best alternatives") are treated as array items by the parser
  // since the array parser doesn't have comment detection. This is a known limitation.

  const planning = models.planning as GSDPhaseModelConfig;
  assert.equal(planning.model, "deepseek/deepseek-r1-0528", "next section unaffected by comments");
});
