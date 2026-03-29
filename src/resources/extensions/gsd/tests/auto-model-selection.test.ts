import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolvePreferredModelConfig, resolveModelId } from "../auto-model-selection.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("resolvePreferredModelConfig synthesizes heavy routing ceiling when models section is absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig("plan-slice", {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });

    assert.deepEqual(config, {
      primary: "claude-opus-4-6",
      fallbacks: [],
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("resolvePreferredModelConfig falls back to auto start model when heavy tier is absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig("execute-task", {
      provider: "openai",
      id: "gpt-5.4",
    });

    assert.deepEqual(config, {
      primary: "openai/gpt-5.4",
      fallbacks: [],
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("resolvePreferredModelConfig keeps explicit phase models as the ceiling", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  planning: claude-sonnet-4-6",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig("plan-slice", {
      provider: "anthropic",
      id: "claude-opus-4-6",
    });

    assert.deepEqual(config, {
      primary: "claude-sonnet-4-6",
      fallbacks: [],
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

// ─── resolveModelId tests ─────────────────────────────────────────────────

test("resolveModelId: bare ID resolves to anthropic over claude-code when session is claude-code (#2905)", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  // Bug: when currentProvider is "claude-code", bare ID "claude-sonnet-4-6"
  // resolves to claude-code/claude-sonnet-4-6 instead of anthropic/claude-sonnet-4-6
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic", "bare ID must resolve to anthropic, not claude-code");
});

test("resolveModelId: bare ID still prefers current provider when it is a first-class API provider", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "bedrock" },
  ];

  const result = resolveModelId("claude-sonnet-4-6", availableModels, "bedrock");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "bedrock", "bare ID should prefer current provider when it is a real API provider");
});

test("resolveModelId: explicit provider/model format still resolves to claude-code when specified", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  const result = resolveModelId("claude-code/claude-sonnet-4-6", availableModels, "anthropic");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "explicit provider prefix must be respected");
});

test("resolveModelId: bare ID with only one provider works normally", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  const result = resolveModelId("claude-sonnet-4-6", availableModels, "anthropic");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic");
});

test("resolveModelId: bare ID with claude-code as only provider still resolves", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  // If claude-code is the ONLY provider for this model, it should still resolve
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve even when only available via claude-code");
  assert.equal(result.provider, "claude-code");
});

test("resolveModelId: anthropic wins over claude-code regardless of list order", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  // Even when claude-code appears first in the list, anthropic should win
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic", "anthropic must win over claude-code regardless of list order");
});
