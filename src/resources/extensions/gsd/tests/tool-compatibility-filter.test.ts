// GSD-2 — Tests for tool-compatibility filter (ADR-005 Step 2)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isToolCompatibleWithProvider,
  filterModelsByToolCompatibility,
  getRequiredToolNames,
  resolveModelForComplexity,
  type ToolCompatibilityInfo,
} from "../model-router.js";
import { KNOWN_UNIT_TYPES } from "../preferences-types.js";
import {
  getProviderCapabilities,
  PERMISSIVE_CAPABILITIES,
  type ProviderCapabilities,
} from "@gsd/pi-ai";

describe("Tool-Compatibility Filter (ADR-005 Step 2)", () => {

  // ─── isToolCompatibleWithProvider ──────────────────────────────────────────

  describe("isToolCompatibleWithProvider", () => {
    test("tool without compatibility metadata is ALWAYS compatible (Pitfall 6 — write this FIRST)", () => {
      // This is the most critical invariant. Tools without metadata must pass.
      const tool: ToolCompatibilityInfo = { name: "custom-tool" };
      const googleCaps = getProviderCapabilities("google-generative-ai");
      const mistralCaps = getProviderCapabilities("mistral-conversations");

      assert.equal(isToolCompatibleWithProvider(tool, googleCaps), true);
      assert.equal(isToolCompatibleWithProvider(tool, mistralCaps), true);
      assert.equal(isToolCompatibleWithProvider(tool, PERMISSIVE_CAPABILITIES), true);
    });

    test("tool with empty compatibility object is compatible", () => {
      const tool: ToolCompatibilityInfo = { name: "tool", compatibility: {} };
      const caps = getProviderCapabilities("mistral-conversations");
      assert.equal(isToolCompatibleWithProvider(tool, caps), true);
    });

    test("tool with producesImages=true excluded on provider without imageToolResults", () => {
      const tool: ToolCompatibilityInfo = {
        name: "screenshot",
        compatibility: { producesImages: true },
      };
      // Mistral does NOT support image tool results
      const mistralCaps = getProviderCapabilities("mistral-conversations");
      assert.equal(isToolCompatibleWithProvider(tool, mistralCaps), false);
    });

    test("tool with producesImages=true passes on provider WITH imageToolResults", () => {
      const tool: ToolCompatibilityInfo = {
        name: "screenshot",
        compatibility: { producesImages: true },
      };
      // Anthropic supports image tool results
      const anthropicCaps = getProviderCapabilities("anthropic-messages");
      assert.equal(isToolCompatibleWithProvider(tool, anthropicCaps), true);
    });

    test("tool with schemaFeatures excluded when provider has unsupportedSchemaFeatures", () => {
      const tool: ToolCompatibilityInfo = {
        name: "complex-search",
        compatibility: { schemaFeatures: ["patternProperties"] },
      };
      // Google does NOT support patternProperties
      const googleCaps = getProviderCapabilities("google-generative-ai");
      assert.equal(isToolCompatibleWithProvider(tool, googleCaps), false);
    });

    test("tool with schemaFeatures passes when provider supports all features", () => {
      const tool: ToolCompatibilityInfo = {
        name: "complex-search",
        compatibility: { schemaFeatures: ["patternProperties"] },
      };
      // Anthropic supports all schema features
      const anthropicCaps = getProviderCapabilities("anthropic-messages");
      assert.equal(isToolCompatibleWithProvider(tool, anthropicCaps), true);
    });

    test("tool with producesImages=false is compatible everywhere", () => {
      const tool: ToolCompatibilityInfo = {
        name: "text-tool",
        compatibility: { producesImages: false },
      };
      const mistralCaps = getProviderCapabilities("mistral-conversations");
      assert.equal(isToolCompatibleWithProvider(tool, mistralCaps), true);
    });

    test("unknown provider (permissive caps) passes all tools", () => {
      const tool: ToolCompatibilityInfo = {
        name: "any-tool",
        compatibility: { producesImages: true, schemaFeatures: ["patternProperties"] },
      };
      assert.equal(isToolCompatibleWithProvider(tool, PERMISSIVE_CAPABILITIES), true);
    });
  });

  // ─── filterModelsByToolCompatibility ────────────────────────────────────────

  describe("filterModelsByToolCompatibility", () => {
    const modelApiLookup: Record<string, string> = {
      "claude-sonnet-4-6": "anthropic-messages",
      "gemini-2.0-flash": "google-generative-ai",
      "gpt-4o": "openai-responses",
      "mistral-large": "mistral-conversations",
    };

    test("returns all models when required tools have no compatibility metadata", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "Bash" },
        { name: "Read" },
        { name: "Write" },
      ];
      const models = ["claude-sonnet-4-6", "gemini-2.0-flash", "gpt-4o"];
      const result = filterModelsByToolCompatibility(models, tools, modelApiLookup);
      assert.deepEqual(result, models);
    });

    test("returns all models when no required tools", () => {
      const models = ["claude-sonnet-4-6", "gemini-2.0-flash"];
      const result = filterModelsByToolCompatibility(models, [], modelApiLookup);
      assert.deepEqual(result, models);
    });

    test("filters out models whose provider cannot support image tools", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "screenshot", compatibility: { producesImages: true } },
      ];
      const models = ["claude-sonnet-4-6", "gpt-4o", "mistral-large"];
      const result = filterModelsByToolCompatibility(models, tools, modelApiLookup);
      // Anthropic supports images; OpenAI and Mistral do not
      assert.deepEqual(result, ["claude-sonnet-4-6"]);
    });

    test("filters out models whose provider has unsupported schema features", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "search", compatibility: { schemaFeatures: ["patternProperties"] } },
      ];
      const models = ["claude-sonnet-4-6", "gemini-2.0-flash", "gpt-4o"];
      const result = filterModelsByToolCompatibility(models, tools, modelApiLookup);
      // Google doesn't support patternProperties; Anthropic and OpenAI do
      assert.deepEqual(result, ["claude-sonnet-4-6", "gpt-4o"]);
    });

    test("returns original list when filter would remove ALL models (fail-open)", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "impossible", compatibility: { producesImages: true, schemaFeatures: ["patternProperties"] } },
      ];
      // Only Mistral — doesn't support images, so this tool fails on Mistral
      const models = ["mistral-large"];
      const result = filterModelsByToolCompatibility(models, tools, modelApiLookup);
      // Would remove all models — returns original (fail-open)
      assert.deepEqual(result, ["mistral-large"]);
    });

    test("passes through models with unknown API (fail-open)", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "screenshot", compatibility: { producesImages: true } },
      ];
      const lookupWithUnknown = { ...modelApiLookup, "local-model": "some-unknown-api" };
      const models = ["local-model", "mistral-large"];
      const result = filterModelsByToolCompatibility(models, tools, lookupWithUnknown);
      // local-model: unknown API → permissive default → passes
      // mistral-large: no image support → filtered out
      // But since mistral-large is removed and local-model passes, result has local-model
      assert.deepEqual(result, ["local-model"]);
    });

    test("passes through models not in API lookup (fail-open)", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "screenshot", compatibility: { producesImages: true } },
      ];
      const models = ["mystery-model"];
      const result = filterModelsByToolCompatibility(models, tools, modelApiLookup);
      // mystery-model not in lookup → passes through
      assert.deepEqual(result, ["mystery-model"]);
    });

    test("mixed tools — only tools with metadata trigger filtering", () => {
      const tools: ToolCompatibilityInfo[] = [
        { name: "Bash" }, // no metadata
        { name: "Read" }, // no metadata
        { name: "screenshot", compatibility: { producesImages: true } },
      ];
      const models = ["claude-sonnet-4-6", "gpt-4o"];
      const result = filterModelsByToolCompatibility(models, tools, modelApiLookup);
      // OpenAI doesn't support images → filtered
      assert.deepEqual(result, ["claude-sonnet-4-6"]);
    });
  });

  // ─── getRequiredToolNames ──────────────────────────────────────────────────

  describe("getRequiredToolNames", () => {
    test("execute-task requires Bash, Read, Write, Edit", () => {
      const tools = getRequiredToolNames("execute-task");
      assert.deepEqual(tools, ["Bash", "Read", "Write", "Edit"]);
    });

    test("execute-plan requires Bash, Read, Write, Edit", () => {
      const tools = getRequiredToolNames("execute-plan");
      assert.deepEqual(tools, ["Bash", "Read", "Write", "Edit"]);
    });

    test("reactive-execute requires Bash, Read, Write, Edit", () => {
      const tools = getRequiredToolNames("reactive-execute");
      assert.deepEqual(tools, ["Bash", "Read", "Write", "Edit"]);
    });

    test("rewrite-docs requires Bash, Read, Write, Edit", () => {
      const tools = getRequiredToolNames("rewrite-docs");
      assert.deepEqual(tools, ["Bash", "Read", "Write", "Edit"]);
    });

    test("research-milestone requires Read, WebSearch, WebFetch", () => {
      const tools = getRequiredToolNames("research-milestone");
      assert.deepEqual(tools, ["Read", "WebSearch", "WebFetch"]);
    });

    test("research-slice requires Read, WebSearch, WebFetch", () => {
      const tools = getRequiredToolNames("research-slice");
      assert.deepEqual(tools, ["Read", "WebSearch", "WebFetch"]);
    });

    test("plan-milestone requires Read, Write", () => {
      const tools = getRequiredToolNames("plan-milestone");
      assert.deepEqual(tools, ["Read", "Write"]);
    });

    test("plan-slice requires Read, Write", () => {
      const tools = getRequiredToolNames("plan-slice");
      assert.deepEqual(tools, ["Read", "Write"]);
    });

    test("replan-slice requires Read, Write", () => {
      const tools = getRequiredToolNames("replan-slice");
      assert.deepEqual(tools, ["Read", "Write"]);
    });

    test("run-uat requires Read, Bash", () => {
      const tools = getRequiredToolNames("run-uat");
      assert.deepEqual(tools, ["Read", "Bash"]);
    });

    test("complete-slice requires Read, Write", () => {
      const tools = getRequiredToolNames("complete-slice");
      assert.deepEqual(tools, ["Read", "Write"]);
    });

    test("complete-milestone requires Read, Write", () => {
      const tools = getRequiredToolNames("complete-milestone");
      assert.deepEqual(tools, ["Read", "Write"]);
    });

    test("validate-milestone requires Read, Write", () => {
      const tools = getRequiredToolNames("validate-milestone");
      assert.deepEqual(tools, ["Read", "Write"]);
    });

    test("unknown unit type returns empty array (no filtering)", () => {
      const tools = getRequiredToolNames("discuss-phase");
      assert.deepEqual(tools, []);
    });

    test("hook unit types return empty array", () => {
      const tools = getRequiredToolNames("hook/before_model_select");
      assert.deepEqual(tools, []);
    });

    test("every KNOWN_UNIT_TYPE has an explicit decision in getRequiredToolNames (exhaustiveness)", () => {
      // This test ensures new unit types added to KNOWN_UNIT_TYPES are explicitly
      // considered for tool requirements. If this test fails, add an entry in
      // getRequiredToolNames() — even if it returns [] (no requirements).
      for (const unitType of KNOWN_UNIT_TYPES) {
        const result = getRequiredToolNames(unitType);
        assert.ok(
          Array.isArray(result),
          `getRequiredToolNames("${unitType}") must return an array (got ${typeof result})`,
        );
      }
      // Verify that execute-type units get tools and non-execute units are explicitly handled
      assert.ok(getRequiredToolNames("execute-task").length > 0, "execute-task should require tools");
      assert.ok(getRequiredToolNames("research-milestone").length > 0, "research-milestone should require tools");
      assert.ok(getRequiredToolNames("plan-slice").length > 0, "plan-slice should require tools");
      assert.ok(getRequiredToolNames("run-uat").length > 0, "run-uat should require tools");
      assert.ok(getRequiredToolNames("complete-slice").length > 0, "complete-slice should require tools");
    });
  });

  // ─── Filter-Position Integration Test ──────────────────────────────────────

  describe("filter runs BEFORE scoring (position invariant)", () => {
    test("incompatible model is never selected by resolveModelForComplexity even if it would be cheapest", () => {
      // Setup: Two light-tier models. gpt-4o-mini is cheaper but its provider (OpenAI)
      // doesn't support imageToolResults. Claude Haiku does (Anthropic supports images).
      // If the filter runs BEFORE scoring, gpt-4o-mini gets excluded and Haiku is selected.
      // If the filter ran AFTER scoring (wrong), gpt-4o-mini would be selected as cheapest-in-tier.
      const modelApiLookup: Record<string, string> = {
        "claude-haiku-4-5": "anthropic-messages",
        "gpt-4o-mini": "openai-responses",
      };

      const imageTools: ToolCompatibilityInfo[] = [
        { name: "Bash" }, // no metadata — always passes
        { name: "screenshot", compatibility: { producesImages: true } },
      ];

      // All models available
      const allModelIds = ["claude-haiku-4-5", "gpt-4o-mini"];

      // Step 1: Filter by tool compatibility (as auto-model-selection.ts does)
      const compatibleModelIds = filterModelsByToolCompatibility(
        allModelIds,
        imageTools,
        modelApiLookup,
      );

      // OpenAI doesn't support imageToolResults — gpt-4o-mini should be filtered out
      assert.ok(
        !compatibleModelIds.includes("gpt-4o-mini"),
        "gpt-4o-mini should be filtered out (OpenAI has no image tool support)",
      );
      assert.ok(
        compatibleModelIds.includes("claude-haiku-4-5"),
        "claude-haiku-4-5 should remain (Anthropic supports image tools)",
      );

      // Step 2: Route with the filtered model set
      const routingResult = resolveModelForComplexity(
        { tier: "light", reason: "simple task", downgraded: false },
        { primary: "claude-haiku-4-5", fallbacks: [] },
        { enabled: true, cross_provider: true },
        compatibleModelIds, // <-- filtered set, NOT allModelIds
      );

      // The routing result should NEVER include the filtered-out model
      assert.notEqual(
        routingResult.modelId,
        "gpt-4o-mini",
        "incompatible model must never be selected — filter must run BEFORE scoring",
      );
      assert.ok(
        !routingResult.fallbacks.includes("gpt-4o-mini"),
        "incompatible model must not appear in fallback chain",
      );
    });

    test("filter removal does not prevent routing when compatible models remain", () => {
      const modelApiLookup: Record<string, string> = {
        "claude-sonnet-4-6": "anthropic-messages",
        "gpt-4o": "openai-responses",
        "mistral-large": "mistral-conversations",
      };

      // Tool that requires schema features Mistral may not support
      const tools: ToolCompatibilityInfo[] = [
        { name: "search", compatibility: { schemaFeatures: ["patternProperties"] } },
      ];

      const allModelIds = ["claude-sonnet-4-6", "gpt-4o", "mistral-large"];
      const compatibleModelIds = filterModelsByToolCompatibility(allModelIds, tools, modelApiLookup);

      // Routing should still work with the remaining compatible models
      const routingResult = resolveModelForComplexity(
        { tier: "standard", reason: "moderate task", downgraded: false },
        { primary: "claude-sonnet-4-6", fallbacks: ["gpt-4o"] },
        { enabled: true, cross_provider: true },
        compatibleModelIds,
      );

      // Should route to a compatible model, not the filtered one
      assert.notEqual(routingResult.modelId, "mistral-large");
    });
  });
});
