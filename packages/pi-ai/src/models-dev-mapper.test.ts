import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapToModelRegistry, parseModelsDevData } from "./models-dev-mapper.js";
import { ModelsDevData, ModelsDevProvider, ModelsDevModel } from "./models-dev-types.js";

/**
 * Sample models.dev response data for testing.
 * Includes 2 providers with 3+ models total.
 */
const sampleModelsDevData: Record<string, ModelsDevProvider> = {
  "anthropic": {
    api: "https://api.anthropic.com/v1",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    id: "anthropic",
    npm: "@anthropic-ai/sdk",
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        family: "claude",
        release_date: "2025-05-14",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.30,
          cache_write: 3.75,
        },
        limit: {
          context: 200000,
          output: 64000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        options: {},
      },
      "claude-opus-4-20250514": {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        family: "claude",
        release_date: "2025-05-14",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: {
          input: 15,
          output: 75,
          cache_read: 1.50,
          cache_write: 18.75,
        },
        limit: {
          context: 200000,
          output: 64000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        options: {},
      },
    },
  },
  "openai": {
    api: "https://api.openai.com/v1",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    id: "openai",
    npm: "openai",
    models: {
      "gpt-4.1": {
        id: "gpt-4.1",
        name: "GPT-4.1",
        family: "gpt-4",
        release_date: "2025-04-14",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.20,
          cache_write: 2.00,
        },
        limit: {
          context: 1000000,
          output: 32768,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        options: {},
      },
      "o3-pro": {
        id: "o3-pro",
        name: "o3 Pro",
        family: "o3",
        release_date: "2025-06-10",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 10,
          output: 40,
        },
        limit: {
          context: 200000,
          output: 100000,
        },
        modalities: {
          input: ["text", "image", "audio"],
          output: ["text", "audio"],
        },
        options: {},
      },
    },
  },
};

describe("models-dev-mapper", () => {
  describe("parseModelsDevData", () => {
    it("should validate valid models.dev data", () => {
      const result = parseModelsDevData(sampleModelsDevData);
      assert.ok(result);
      assert.notEqual(result, null);
    });

    it("should return null for invalid data", () => {
      const invalidData = { invalid: "data" };
      const result = parseModelsDevData(invalidData);
      assert.equal(result, null);
    });
  });

  describe("mapToModelRegistry", () => {
    const registry = mapToModelRegistry(sampleModelsDevData);

    it("should transform all models from sample data", () => {
      assert.equal(registry.length, 4); // 2 from Anthropic + 2 from OpenAI
    });

    it("should use correct field names (camelCase)", () => {
      const model = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(model);
      assert.ok(model!.cost.cacheRead);
      assert.ok(model!.cost.cacheWrite);
      assert.ok(model!.contextWindow);
      assert.ok(model!.maxTokens);
    });

    it("should preserve cost values correctly", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.equal(claudeSonnet!.cost.input, 3);
      assert.equal(claudeSonnet!.cost.output, 15);
      assert.equal(claudeSonnet!.cost.cacheRead, 0.30);
      assert.equal(claudeSonnet!.cost.cacheWrite, 3.75);

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.equal(gpt4!.cost.input, 2);
      assert.equal(gpt4!.cost.output, 8);
    });

    it("should set contextWindow and maxTokens from limit fields", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.equal(claudeSonnet!.contextWindow, 200000);
      assert.equal(claudeSonnet!.maxTokens, 64000);

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.equal(gpt4!.contextWindow, 1000000);
      assert.equal(gpt4!.maxTokens, 32768);
    });

    it("should filter modalities to text/image only", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.deepEqual(claudeSonnet!.input, ["text", "image"]);

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.deepEqual(gpt4!.input, ["text", "image"]);

      // o3-pro has audio but should only have text/image
      const o3Pro = registry.find((m) => m.id === "o3-pro");
      assert.ok(o3Pro);
      assert.deepEqual(o3Pro!.input, ["text", "image"]);
    });

    it("should set provider field from provider ID", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.equal(claudeSonnet!.provider, "anthropic");

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.equal(gpt4!.provider, "openai");
    });

    it("should set api field based on provider", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.equal(claudeSonnet!.api, "anthropic-messages");

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.equal(gpt4!.api, "openai-completions");
    });

    it("should set baseUrl from provider api field", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.equal(claudeSonnet!.baseUrl, "https://api.anthropic.com/v1");

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.equal(gpt4!.baseUrl, "https://api.openai.com/v1");
    });

    it("should set headers to empty object by default", () => {
      registry.forEach((model) => {
        assert.deepEqual(model.headers, {});
      });
    });

    it("should preserve reasoning field", () => {
      const claudeSonnet = registry.find((m) => m.id === "claude-sonnet-4-20250514");
      assert.ok(claudeSonnet);
      assert.equal(claudeSonnet!.reasoning, true);

      const gpt4 = registry.find((m) => m.id === "gpt-4.1");
      assert.ok(gpt4);
      assert.equal(gpt4!.reasoning, false);
    });

    it("should handle missing optional cost fields with defaults", () => {
      const o3Pro = registry.find((m) => m.id === "o3-pro");
      assert.ok(o3Pro);
      assert.equal(o3Pro!.cost.input, 10);
      assert.equal(o3Pro!.cost.output, 40);
      // Missing cache_read/cache_write should default to 0
      assert.equal(o3Pro!.cost.cacheRead, 0);
      assert.equal(o3Pro!.cost.cacheWrite, 0);
    });

    it("should handle models without modalities", () => {
      // Create data with a model missing modalities
      const dataWithoutModalities: Record<string, ModelsDevProvider> = {
        test: {
          api: "https://test.com",
          name: "Test",
          env: [],
          id: "test",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              release_date: "2025-01-01",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: false,
              limit: { context: 100000, output: 4096 },
              options: {},
            },
          },
        },
      };

      const result = mapToModelRegistry(dataWithoutModalities);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0].input, ["text"]); // Default to text-only
    });
  });
});
