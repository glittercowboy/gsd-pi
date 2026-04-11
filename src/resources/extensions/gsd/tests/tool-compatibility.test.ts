// GSD-2 — Tool Compatibility + Model Router Tool Filtering Tests (ADR-005 Phases 2-3)
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerToolCompatibility,
  getToolCompatibility,
  getAllToolCompatibility,
  registerMcpToolCompatibility,
  resetToolCompatibilityRegistry,
} from "@gsd/pi-coding-agent";

import {
  isToolCompatibleWithProvider,
  filterToolsForProvider,
  adjustToolSet,
} from "../model-router.js";

import {
  getProviderCapabilities,
} from "@gsd/pi-ai";

// ─── Tool Compatibility Registry ────────────────────────────────────────────

describe("tool compatibility registry", () => {
  beforeEach(() => {
    resetToolCompatibilityRegistry();
  });

  test("built-in tools are pre-registered", () => {
    const builtins = ["bash", "read", "write", "edit", "grep", "find", "ls", "lsp"];
    for (const name of builtins) {
      const compat = getToolCompatibility(name);
      assert.ok(compat !== undefined, `${name} should be pre-registered`);
    }
  });

  test("unknown tool returns undefined", () => {
    assert.equal(getToolCompatibility("nonexistent_tool_xyz"), undefined);
  });

  test("registerToolCompatibility stores and retrieves metadata", () => {
    registerToolCompatibility("screenshot_tool", {
      producesImages: true,
      minCapabilityTier: "standard",
    });
    const compat = getToolCompatibility("screenshot_tool");
    assert.ok(compat);
    assert.equal(compat.producesImages, true);
    assert.equal(compat.minCapabilityTier, "standard");
  });

  test("registerMcpToolCompatibility sets default schema features", () => {
    registerMcpToolCompatibility("mcp__test__tool");
    const compat = getToolCompatibility("mcp__test__tool");
    assert.ok(compat);
    assert.ok(compat.schemaFeatures?.includes("patternProperties"));
  });

  test("registerMcpToolCompatibility allows overrides", () => {
    registerMcpToolCompatibility("mcp__test__override", { producesImages: true });
    const compat = getToolCompatibility("mcp__test__override");
    assert.ok(compat);
    assert.equal(compat.producesImages, true);
    assert.ok(compat.schemaFeatures?.includes("patternProperties"));
  });

  test("getAllToolCompatibility returns all entries", () => {
    const all = getAllToolCompatibility();
    assert.ok(all.size >= 10); // at least built-in tools
    assert.ok(all.has("bash"));
    assert.ok(all.has("read"));
  });

  test("resetToolCompatibilityRegistry clears custom entries but keeps builtins", () => {
    registerToolCompatibility("custom_tool", { producesImages: true });
    assert.ok(getToolCompatibility("custom_tool"));
    resetToolCompatibilityRegistry();
    assert.equal(getToolCompatibility("custom_tool"), undefined);
    assert.ok(getToolCompatibility("bash")); // built-in preserved
  });
});

// ─── isToolCompatibleWithProvider ───────────────────────────────────────────

describe("isToolCompatibleWithProvider", () => {
  beforeEach(() => {
    resetToolCompatibilityRegistry();
  });

  test("tool without compatibility metadata is always compatible", () => {
    const caps = getProviderCapabilities("anthropic-messages");
    assert.equal(isToolCompatibleWithProvider("unknown_tool", caps), true);
  });

  test("built-in tools are compatible with all providers", () => {
    const providers = ["anthropic-messages", "openai-responses", "google-generative-ai", "mistral-conversations"];
    const tools = ["bash", "read", "write", "edit"];
    for (const api of providers) {
      const caps = getProviderCapabilities(api);
      for (const tool of tools) {
        assert.equal(
          isToolCompatibleWithProvider(tool, caps),
          true,
          `${tool} should be compatible with ${api}`,
        );
      }
    }
  });

  test("image-producing tool filtered for providers without image support", () => {
    registerToolCompatibility("screenshot", { producesImages: true });
    const openaiCaps = getProviderCapabilities("openai-responses");
    assert.equal(isToolCompatibleWithProvider("screenshot", openaiCaps), false);

    const anthropicCaps = getProviderCapabilities("anthropic-messages");
    assert.equal(isToolCompatibleWithProvider("screenshot", anthropicCaps), true);
  });

  test("tool with unsupported schema features filtered for Google", () => {
    registerToolCompatibility("complex_schema_tool", {
      schemaFeatures: ["patternProperties"],
    });
    const googleCaps = getProviderCapabilities("google-generative-ai");
    assert.equal(isToolCompatibleWithProvider("complex_schema_tool", googleCaps), false);

    const anthropicCaps = getProviderCapabilities("anthropic-messages");
    assert.equal(isToolCompatibleWithProvider("complex_schema_tool", anthropicCaps), true);
  });
});

// ─── filterToolsForProvider ─────────────────────────────────────────────────

describe("filterToolsForProvider", () => {
  beforeEach(() => {
    resetToolCompatibilityRegistry();
  });

  test("all built-in tools pass for any provider", () => {
    const toolNames = ["bash", "read", "write", "edit", "grep", "find", "ls"];
    const { compatible, filtered } = filterToolsForProvider(toolNames, "mistral-conversations");
    assert.deepEqual(compatible, toolNames);
    assert.deepEqual(filtered, []);
  });

  test("image tool filtered for OpenAI Responses", () => {
    registerToolCompatibility("browser_screenshot", { producesImages: true });
    const toolNames = ["bash", "read", "browser_screenshot"];
    const { compatible, filtered } = filterToolsForProvider(toolNames, "openai-responses");
    assert.deepEqual(compatible, ["bash", "read"]);
    assert.deepEqual(filtered, ["browser_screenshot"]);
  });

  test("MCP tool with patternProperties filtered for Google", () => {
    registerMcpToolCompatibility("mcp__repowise__search");
    const toolNames = ["bash", "read", "mcp__repowise__search"];
    const { compatible, filtered } = filterToolsForProvider(toolNames, "google-generative-ai");
    assert.deepEqual(compatible, ["bash", "read"]);
    assert.deepEqual(filtered, ["mcp__repowise__search"]);
  });

  test("unknown provider passes all tools (permissive default)", () => {
    registerToolCompatibility("image_tool", { producesImages: true });
    registerMcpToolCompatibility("mcp_tool");
    const toolNames = ["bash", "image_tool", "mcp_tool"];
    const { compatible, filtered } = filterToolsForProvider(toolNames, "unknown-provider-xyz");
    assert.deepEqual(compatible, toolNames);
    assert.deepEqual(filtered, []);
  });
});

// ─── adjustToolSet ──────────────────────────────────────────────────────────

describe("adjustToolSet", () => {
  beforeEach(() => {
    resetToolCompatibilityRegistry();
  });

  test("returns all tools for Anthropic (most permissive)", () => {
    registerToolCompatibility("screenshot", { producesImages: true });
    const toolNames = ["bash", "read", "screenshot"];
    const { toolNames: result, removedTools } = adjustToolSet(toolNames, "anthropic-messages");
    assert.deepEqual(result, toolNames);
    assert.deepEqual(removedTools, []);
  });

  test("removes incompatible tools and reports them", () => {
    registerToolCompatibility("screenshot", { producesImages: true });
    registerMcpToolCompatibility("mcp_complex");
    const toolNames = ["bash", "read", "screenshot", "mcp_complex"];
    const { toolNames: result, removedTools } = adjustToolSet(toolNames, "google-generative-ai");
    // Google supports images but not patternProperties
    assert.ok(result.includes("bash"));
    assert.ok(result.includes("read"));
    assert.ok(result.includes("screenshot")); // Google supports images
    assert.ok(!result.includes("mcp_complex")); // patternProperties not supported
    assert.deepEqual(removedTools, ["mcp_complex"]);
  });
});
