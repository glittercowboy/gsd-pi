// GSD-2 — Provider Capabilities Registry Tests (ADR-005 Phase 1)
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_CAPABILITIES,
  getProviderCapabilities,
  getUnsupportedFeatures,
  mergeCapabilityOverrides,
  getRegisteredApis,
} from "./provider-capabilities.js";

// ─── Registry Completeness ──────────────────────────────────────────────────

describe("PROVIDER_CAPABILITIES registry", () => {
  const EXPECTED_APIS = [
    "anthropic-messages",
    "anthropic-vertex",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "openai-completions",
    "google-generative-ai",
    "google-gemini-cli",
    "google-vertex",
    "mistral-conversations",
    "bedrock-converse-stream",
    "ollama-chat",
  ];

  test("covers all expected API providers", () => {
    for (const api of EXPECTED_APIS) {
      assert.ok(
        PROVIDER_CAPABILITIES[api],
        `Missing capability entry for API: ${api}`,
      );
    }
  });

  test("getRegisteredApis returns all entries", () => {
    const registered = getRegisteredApis();
    for (const api of EXPECTED_APIS) {
      assert.ok(registered.includes(api), `getRegisteredApis missing: ${api}`);
    }
  });

  test("all entries have required fields", () => {
    for (const [api, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
      assert.equal(typeof caps.toolCalling, "boolean", `${api}.toolCalling`);
      assert.equal(typeof caps.maxTools, "number", `${api}.maxTools`);
      assert.equal(typeof caps.imageToolResults, "boolean", `${api}.imageToolResults`);
      assert.equal(typeof caps.structuredOutput, "boolean", `${api}.structuredOutput`);
      assert.ok(caps.toolCallIdFormat, `${api}.toolCallIdFormat`);
      assert.equal(typeof caps.toolCallIdFormat.maxLength, "number", `${api}.toolCallIdFormat.maxLength`);
      assert.ok(caps.toolCallIdFormat.allowedChars instanceof RegExp, `${api}.toolCallIdFormat.allowedChars`);
      assert.ok(
        ["full", "text-only", "none"].includes(caps.thinkingPersistence),
        `${api}.thinkingPersistence is "${caps.thinkingPersistence}"`,
      );
      assert.ok(Array.isArray(caps.unsupportedSchemaFeatures), `${api}.unsupportedSchemaFeatures`);
    }
  });
});

// ─── Provider-specific Values ───────────────────────────────────────────────

describe("provider-specific capabilities", () => {
  test("Anthropic supports full thinking persistence", () => {
    assert.equal(PROVIDER_CAPABILITIES["anthropic-messages"].thinkingPersistence, "full");
  });

  test("Anthropic supports image tool results", () => {
    assert.equal(PROVIDER_CAPABILITIES["anthropic-messages"].imageToolResults, true);
  });

  test("Anthropic tool call ID is 64 chars max", () => {
    assert.equal(PROVIDER_CAPABILITIES["anthropic-messages"].toolCallIdFormat.maxLength, 64);
  });

  test("Mistral tool call ID is 9 chars max", () => {
    assert.equal(PROVIDER_CAPABILITIES["mistral-conversations"].toolCallIdFormat.maxLength, 9);
  });

  test("Mistral has no thinking persistence", () => {
    assert.equal(PROVIDER_CAPABILITIES["mistral-conversations"].thinkingPersistence, "none");
  });

  test("Google does not support patternProperties", () => {
    assert.ok(
      PROVIDER_CAPABILITIES["google-generative-ai"].unsupportedSchemaFeatures.includes("patternProperties"),
    );
  });

  test("Google does not support const", () => {
    assert.ok(
      PROVIDER_CAPABILITIES["google-generative-ai"].unsupportedSchemaFeatures.includes("const"),
    );
  });

  test("OpenAI Responses does not support image tool results", () => {
    assert.equal(PROVIDER_CAPABILITIES["openai-responses"].imageToolResults, false);
  });

  test("OpenAI Responses has text-only thinking persistence", () => {
    assert.equal(PROVIDER_CAPABILITIES["openai-responses"].thinkingPersistence, "text-only");
  });
});

// ─── getProviderCapabilities ────────────────────────────────────────────────

describe("getProviderCapabilities", () => {
  test("returns known provider capabilities", () => {
    const caps = getProviderCapabilities("anthropic-messages");
    assert.equal(caps.toolCalling, true);
    assert.equal(caps.thinkingPersistence, "full");
  });

  test("returns permissive defaults for unknown providers", () => {
    const caps = getProviderCapabilities("unknown-provider-xyz");
    assert.equal(caps.toolCalling, true);
    assert.equal(caps.imageToolResults, true);
    assert.deepEqual(caps.unsupportedSchemaFeatures, []);
  });
});

// ─── getUnsupportedFeatures ─────────────────────────────────────────────────

describe("getUnsupportedFeatures", () => {
  test("returns unsupported features for Google", () => {
    const unsupported = getUnsupportedFeatures("google-generative-ai", ["patternProperties", "const"]);
    assert.deepEqual(unsupported, ["patternProperties", "const"]);
  });

  test("returns empty for Anthropic with any features", () => {
    const unsupported = getUnsupportedFeatures("anthropic-messages", ["patternProperties", "const"]);
    assert.deepEqual(unsupported, []);
  });

  test("returns empty for unknown provider", () => {
    const unsupported = getUnsupportedFeatures("unknown-xyz", ["patternProperties"]);
    assert.deepEqual(unsupported, []);
  });
});

// ─── mergeCapabilityOverrides ───────────────────────────────────────────────

describe("mergeCapabilityOverrides", () => {
  test("overrides individual fields", () => {
    const merged = mergeCapabilityOverrides("openai-responses", {
      imageToolResults: true,
    });
    assert.equal(merged.imageToolResults, true);
    // Non-overridden fields preserved
    assert.equal(merged.toolCalling, true);
    assert.equal(merged.thinkingPersistence, "text-only");
  });

  test("deep-merges toolCallIdFormat", () => {
    const merged = mergeCapabilityOverrides("anthropic-messages", {
      toolCallIdFormat: { maxLength: 128 },
    });
    assert.equal(merged.toolCallIdFormat.maxLength, 128);
    // allowedChars preserved from base
    assert.ok(merged.toolCallIdFormat.allowedChars instanceof RegExp);
  });

  test("uses permissive defaults for unknown provider", () => {
    const merged = mergeCapabilityOverrides("unknown-xyz", {
      imageToolResults: false,
    });
    assert.equal(merged.imageToolResults, false);
    assert.equal(merged.toolCalling, true); // from default
  });
});
