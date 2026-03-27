// GSD-2 — Tests for adjustToolSet (ADR-005 Phase 4)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { adjustToolSet } from "../auto-model-selection.js";
import { getProviderCapabilities, PERMISSIVE_CAPABILITIES, type ProviderCapabilities } from "@gsd/pi-ai";

describe("adjustToolSet (ADR-005)", () => {
  const baseTool = (name: string, opts?: { producesImages?: boolean; schemaFeatures?: string[]; priority?: number }) => ({
    name,
    compatibility: opts?.producesImages !== undefined || opts?.schemaFeatures !== undefined
      ? { producesImages: opts.producesImages, schemaFeatures: opts.schemaFeatures }
      : undefined,
    priority: opts?.priority,
  });

  test("tools without compatibility metadata are always included", () => {
    const tools = [baseTool("Bash"), baseTool("Read"), baseTool("Write")];
    const caps = getProviderCapabilities("mistral-conversations");
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(t => t.name), ["Bash", "Read", "Write"]);
  });

  test("tool with producesImages excluded on provider without imageToolResults", () => {
    const tools = [
      baseTool("Bash"),
      baseTool("screenshot", { producesImages: true }),
    ];
    const caps = getProviderCapabilities("openai-responses"); // no image tool results
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Bash");
  });

  test("tool with producesImages passes on provider with imageToolResults", () => {
    const tools = [
      baseTool("Bash"),
      baseTool("screenshot", { producesImages: true }),
    ];
    const caps = getProviderCapabilities("anthropic-messages"); // supports images
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 2);
  });

  test("tool with unsupported schemaFeatures excluded", () => {
    const tools = [
      baseTool("Read"),
      baseTool("complex-search", { schemaFeatures: ["patternProperties"] }),
    ];
    const caps = getProviderCapabilities("google-generative-ai"); // unsupports patternProperties
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Read");
  });

  test("maxTools pruning keeps highest-priority tools", () => {
    const tools = [
      baseTool("Bash", { priority: 10 }),
      baseTool("Read", { priority: 8 }),
      baseTool("Write", { priority: 5 }),
      baseTool("Search", { priority: 3 }),
      baseTool("Extra", { priority: 1 }),
    ];
    const caps: ProviderCapabilities = {
      ...PERMISSIVE_CAPABILITIES,
      maxTools: 3,
    };
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(t => t.name), ["Bash", "Read", "Write"]);
  });

  test("maxTools=0 means unlimited (no pruning)", () => {
    const tools = [
      baseTool("A", { priority: 1 }),
      baseTool("B", { priority: 2 }),
      baseTool("C", { priority: 3 }),
    ];
    const caps: ProviderCapabilities = {
      ...PERMISSIVE_CAPABILITIES,
      maxTools: 0,
    };
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 3);
  });

  test("tools without priority default to 1 during pruning", () => {
    const tools = [
      baseTool("Bash", { priority: 10 }),
      baseTool("Read"), // priority defaults to 1
      baseTool("Extra"), // priority defaults to 1
    ];
    const caps: ProviderCapabilities = {
      ...PERMISSIVE_CAPABILITIES,
      maxTools: 1,
    };
    const result = adjustToolSet(tools, caps);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Bash");
  });

  test("empty tools returns empty result", () => {
    const caps = getProviderCapabilities("anthropic-messages");
    const result = adjustToolSet([], caps);
    assert.equal(result.length, 0);
  });

  test("permissive capabilities do not filter anything", () => {
    const tools = [
      baseTool("Bash"),
      baseTool("screenshot", { producesImages: true }),
      baseTool("complex", { schemaFeatures: ["patternProperties", "anyOf"] }),
    ];
    const result = adjustToolSet(tools, PERMISSIVE_CAPABILITIES);
    assert.equal(result.length, 3);
  });
});
