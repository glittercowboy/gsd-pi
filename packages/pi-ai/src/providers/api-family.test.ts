// gsd-2 / pi-ai: api-family predicate tests
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isAnthropicApi,
  isBedrockApi,
  isGeminiApi,
  isOpenAIApi,
} from "./api-family.js";

// Every api value registered via registerApiProvider() in register-builtins.ts.
// Keep in sync with that file — the expectations below assert every api is
// classified by exactly one family (except mistral, which is its own family
// and belongs to none of the helpers).
const ALL_REGISTERED_APIS = [
  "anthropic-messages",
  "anthropic-vertex",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
] as const;

describe("isAnthropicApi", () => {
  test("matches anthropic-messages and anthropic-vertex", () => {
    assert.equal(isAnthropicApi({ api: "anthropic-messages" }), true);
    assert.equal(isAnthropicApi({ api: "anthropic-vertex" }), true);
  });

  test("excludes bedrock-converse-stream (different tool schema)", () => {
    assert.equal(isAnthropicApi({ api: "bedrock-converse-stream" }), false);
  });

  test("excludes every non-Anthropic registered api", () => {
    const nonAnthropic = ALL_REGISTERED_APIS.filter(
      (a) => a !== "anthropic-messages" && a !== "anthropic-vertex",
    );
    for (const api of nonAnthropic) {
      assert.equal(isAnthropicApi({ api }), false, `api=${api}`);
    }
  });

  test("tolerates null/undefined/missing api", () => {
    assert.equal(isAnthropicApi(null), false);
    assert.equal(isAnthropicApi(undefined), false);
    assert.equal(isAnthropicApi({}), false);
    assert.equal(isAnthropicApi({ api: "" }), false);
  });
});

describe("isOpenAIApi", () => {
  test("matches all OpenAI-shaped apis", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
    ]) {
      assert.equal(isOpenAIApi({ api }), true, `api=${api}`);
    }
  });

  test("excludes every non-OpenAI registered api", () => {
    const nonOpenAI = ALL_REGISTERED_APIS.filter(
      (a) =>
        a !== "openai-completions" &&
        a !== "openai-responses" &&
        a !== "azure-openai-responses" &&
        a !== "openai-codex-responses",
    );
    for (const api of nonOpenAI) {
      assert.equal(isOpenAIApi({ api }), false, `api=${api}`);
    }
  });
});

describe("isGeminiApi", () => {
  test("matches all Gemini-shaped apis", () => {
    for (const api of ["google-generative-ai", "google-gemini-cli", "google-vertex"]) {
      assert.equal(isGeminiApi({ api }), true, `api=${api}`);
    }
  });

  test("excludes every non-Gemini registered api", () => {
    const nonGemini = ALL_REGISTERED_APIS.filter(
      (a) =>
        a !== "google-generative-ai" &&
        a !== "google-gemini-cli" &&
        a !== "google-vertex",
    );
    for (const api of nonGemini) {
      assert.equal(isGeminiApi({ api }), false, `api=${api}`);
    }
  });
});

describe("isBedrockApi", () => {
  test("matches only bedrock-converse-stream", () => {
    assert.equal(isBedrockApi({ api: "bedrock-converse-stream" }), true);
    for (const api of ALL_REGISTERED_APIS.filter((a) => a !== "bedrock-converse-stream")) {
      assert.equal(isBedrockApi({ api }), false, `api=${api}`);
    }
  });
});

describe("api-family exclusivity", () => {
  test("every registered api belongs to exactly one family (or mistral = none)", () => {
    for (const api of ALL_REGISTERED_APIS) {
      const matches = [
        isAnthropicApi({ api }),
        isOpenAIApi({ api }),
        isGeminiApi({ api }),
        isBedrockApi({ api }),
      ].filter(Boolean).length;
      const expected = api === "mistral-conversations" ? 0 : 1;
      assert.equal(
        matches,
        expected,
        `api=${api} matched ${matches} families (expected ${expected})`,
      );
    }
  });
});
