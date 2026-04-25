import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { resolvePreferredModelConfig, resolveModelId, selectAndApplyModel } from "../auto-model-selection.js";

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
      source: "synthesized",
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
      source: "synthesized",
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
      source: "explicit",
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("selectAndApplyModel honors explicit phase models without downgrading (#3617)", async () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");
  const setModelCalls: string[] = [];
  let beforeModelSelectCalled = false;

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  planning: claude-opus-4-6",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: gpt-4o-mini",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const availableModels = [
      { id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "gpt-4o-mini", provider: "openai", api: "responses" },
    ];

    const result = await selectAndApplyModel(
      {
        modelRegistry: { getAvailable: () => availableModels },
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: () => {} },
        model: { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" },
      } as any,
      {
        setModel: async (model: { provider: string; id: string }) => {
          setModelCalls.push(`${model.provider}/${model.id}`);
          return true;
        },
        emitBeforeModelSelect: async () => {
          beforeModelSelectCalled = true;
          return undefined;
        },
        getActiveTools: () => [],
        emitAdjustToolSet: async () => undefined,
        setActiveTools: () => {},
      } as any,
      "plan-slice",
      "slice-1",
      tempProject,
      undefined,
      false,
      { provider: "anthropic", id: "claude-opus-4-6" },
      undefined,
      true,
    );

    assert.equal(beforeModelSelectCalled, false, "explicit phase models should skip dynamic routing hooks");
    assert.deepEqual(setModelCalls, ["anthropic/claude-opus-4-6"]);
    assert.equal(result.routing, null, "explicit phase models should not record a routing downgrade");
    assert.equal(result.appliedModel?.provider, "anthropic");
    assert.equal(result.appliedModel?.id, "claude-opus-4-6");
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

// ─── resolveModelId tests ─────────────────────────────────────────────────

test("resolveModelId: bare ID resolves to claude-code when session is claude-code (#3772)", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  // When currentProvider is "claude-code" (set by startup migration for subscription
  // users), bare IDs must resolve to claude-code to avoid the third-party block (#3772).
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "bare ID must resolve to claude-code when session provider is claude-code");
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

// ─── selectAndApplyModel verbose-gating tests ──────────────────────────

test("model change notify in selectAndApplyModel is gated behind verbose flag", () => {
  // The Model [phase] [tier] notification should only fire when verbose=true.
  // The dashboard header already shows the active model, so the notification
  // is redundant noise during auto-mode (#3719).
  const gsdDir = join(__dirname, "..");
  const src = readFileSync(join(gsdDir, "auto-model-selection.ts"), "utf-8");

  // Find the block where setModel succeeds (appliedModel = model) and
  // verify notify is inside an `if (verbose)` guard.
  const setModelBlock = src.match(
    /const ok = await pi\.setModel\(model[\s\S]*?appliedModel = model;([\s\S]*?)break;/,
  );
  assert.ok(setModelBlock, "should find the setModel success block");

  const blockBody = setModelBlock![1];
  // The notify call must be inside an if (verbose) block
  assert.ok(
    blockBody.includes("if (verbose)"),
    "Model change ctx.ui.notify must be gated behind if (verbose) to avoid auto-mode notification noise",
  );
  assert.ok(
    blockBody.includes("ctx.ui.notify"),
    "notify call should still exist (just verbose-gated)",
  );
});

test("model policy resolves candidates from the policy-eligible pool", () => {
  const src = readFileSync(join(__dirname, "..", "auto-model-selection.ts"), "utf-8");
  assert.ok(
    src.includes("const resolutionPool = uokFlags.modelPolicy ? routingEligibleModels : availableModels"),
    "selectAndApplyModel should resolve model IDs against policy-eligible models when model policy is enabled",
  );
});

test("model policy receives task metadata for requirement-vector decisions", () => {
  const src = readFileSync(join(__dirname, "..", "auto-model-selection.ts"), "utf-8");
  assert.ok(
    src.includes("taskMetadata: taskMetadataForPolicy"),
    "applyModelPolicyFilter should receive task metadata so requirement vectors are unit-aware",
  );
  assert.ok(
    src.includes("extractTaskMetadata(unitId, basePath)"),
    "execute-task dispatch should derive metadata before policy filtering",
  );
});

test("dynamic routing passes provider-qualified model keys to the router", () => {
  const src = readFileSync(join(__dirname, "..", "auto-model-selection.ts"), "utf-8");
  assert.ok(
    src.includes("routingEligibleModels.map(m => `${m.provider}/${m.id}`)"),
    "selectAndApplyModel should preserve provider prefixes for dynamic routing candidates",
  );
  assert.ok(
    !src.includes("routingEligibleModels.map(m => m.id)"),
    "selectAndApplyModel must not strip providers before resolving tier_models",
  );
});

test("selectAndApplyModel re-applies captured thinking level after setModel success", () => {
  const src = readFileSync(join(__dirname, "..", "auto-model-selection.ts"), "utf-8");
  assert.ok(
    src.includes("autoModeStartThinkingLevel?: ReturnType<ExtensionAPI[\"getThinkingLevel\"]> | null"),
    "selectAndApplyModel should accept an autoModeStartThinkingLevel parameter",
  );
  assert.ok(
    src.includes("reapplyThinkingLevel(pi, autoModeStartThinkingLevel)"),
    "selectAndApplyModel should re-apply captured thinking level after model changes",
  );
});

test("resolveModelId: anthropic wins over claude-code when session provider is not claude-code", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  // When the session is NOT on claude-code, bare IDs should resolve to
  // the canonical anthropic provider (original #2905 behavior preserved).
  const result = resolveModelId("claude-sonnet-4-6", availableModels, undefined);
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic", "anthropic must win when session is not claude-code");
});

test("resolveModelId: claude-code wins when session is claude-code regardless of list order", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  // When session provider is claude-code (subscription user migration), it must
  // win regardless of candidate ordering to avoid the third-party block (#3772).
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "claude-code must win when it is the session provider");
});
