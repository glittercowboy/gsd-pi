/**
 * Regression test for #3453: dynamic model routing must be disabled for
 * flat-rate providers like GitHub Copilot where all models cost the same
 * per request — routing only degrades quality with no cost benefit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFlatRateContext, isFlatRateProvider, resolvePreferredModelConfig } from "../auto-model-selection.ts";

const __dirname_4386 = dirname(fileURLToPath(import.meta.url));

describe("flat-rate provider routing guard (#3453)", () => {

  test("isFlatRateProvider returns true for github-copilot", () => {
    assert.equal(isFlatRateProvider("github-copilot"), true);
  });

  test("isFlatRateProvider returns true for copilot alias", () => {
    assert.equal(isFlatRateProvider("copilot"), true);
  });

  test("isFlatRateProvider is case-insensitive", () => {
    assert.equal(isFlatRateProvider("GitHub-Copilot"), true);
    assert.equal(isFlatRateProvider("GITHUB-COPILOT"), true);
    assert.equal(isFlatRateProvider("Copilot"), true);
  });

  test("isFlatRateProvider returns false for anthropic", () => {
    assert.equal(isFlatRateProvider("anthropic"), false);
  });

  test("isFlatRateProvider returns false for openai", () => {
    assert.equal(isFlatRateProvider("openai"), false);
  });

  test("resolvePreferredModelConfig returns undefined for copilot start model", () => {
    // When the user's start model is on a flat-rate provider,
    // resolvePreferredModelConfig should not synthesize a routing
    // config from tier_models — it should return undefined so the
    // user's selected model is preserved.
    const result = resolvePreferredModelConfig("execute-task", {
      provider: "github-copilot",
      id: "claude-sonnet-4",
    });

    // Should be undefined (no routing config created for flat-rate)
    // Note: this only tests the guard — if explicit per-unit config exists
    // in preferences, that takes precedence regardless.
    assert.equal(result, undefined, "Should not create routing config for copilot");
  });
});

describe("flat-rate provider extensibility (any/all/custom)", () => {
  test("regression: built-in providers still flat-rate with no context", () => {
    assert.equal(isFlatRateProvider("github-copilot"), true);
    assert.equal(isFlatRateProvider("copilot"), true);
    assert.equal(isFlatRateProvider("claude-code"), true);
  });

  test("regression: non-flat-rate API providers return false with no context", () => {
    assert.equal(isFlatRateProvider("anthropic"), false);
    assert.equal(isFlatRateProvider("openai"), false);
    assert.equal(isFlatRateProvider("google-vertex"), false);
  });

  test("auto-detection: externalCli auth mode marks provider flat-rate", () => {
    // Any provider registered with authMode: "externalCli" is a local
    // CLI wrapper around the user's subscription — every request costs
    // the same regardless of model, so dynamic routing provides no benefit.
    assert.equal(
      isFlatRateProvider("my-private-cli", { authMode: "externalCli" }),
      true,
    );
  });

  test("auto-detection: non-externalCli auth modes do not mark provider flat-rate", () => {
    assert.equal(
      isFlatRateProvider("my-http-proxy", { authMode: "apiKey" }),
      false,
    );
    assert.equal(
      isFlatRateProvider("my-http-proxy", { authMode: "oauth" }),
      false,
    );
    assert.equal(
      isFlatRateProvider("my-http-proxy", { authMode: "none" }),
      false,
    );
  });

  test("user preference: custom provider listed in userFlatRate is flat-rate", () => {
    assert.equal(
      isFlatRateProvider("my-ollama-proxy", { userFlatRate: ["my-ollama-proxy"] }),
      true,
    );
  });

  test("user preference: case-insensitive match against userFlatRate list", () => {
    assert.equal(
      isFlatRateProvider("My-Proxy", { userFlatRate: ["my-proxy"] }),
      true,
    );
    assert.equal(
      isFlatRateProvider("my-proxy", { userFlatRate: ["MY-PROXY"] }),
      true,
    );
  });

  test("user preference: provider not in userFlatRate list is not flat-rate", () => {
    assert.equal(
      isFlatRateProvider("other-proxy", { userFlatRate: ["my-proxy"] }),
      false,
    );
  });

  test("combined signals: built-in list wins even when context is empty", () => {
    assert.equal(
      isFlatRateProvider("claude-code", { authMode: "apiKey", userFlatRate: [] }),
      true,
    );
  });

  test("combined signals: externalCli auto-detection wins alongside userFlatRate miss", () => {
    assert.equal(
      isFlatRateProvider("my-cli", {
        authMode: "externalCli",
        userFlatRate: ["a-different-cli"],
      }),
      true,
    );
  });
});

describe("buildFlatRateContext()", () => {
  test("builds a context from ctx.modelRegistry.getProviderAuthMode + prefs", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthMode: (p: string) =>
          p === "my-cli" ? "externalCli" : "apiKey",
      },
    };
    const prefs = { flat_rate_providers: ["my-proxy"] };

    const ctxForCli = buildFlatRateContext("my-cli", ctx, prefs);
    assert.equal(ctxForCli.authMode, "externalCli");
    assert.deepEqual(ctxForCli.userFlatRate, ["my-proxy"]);
    assert.equal(isFlatRateProvider("my-cli", ctxForCli), true);

    const ctxForProxy = buildFlatRateContext("my-proxy", ctx, prefs);
    assert.equal(ctxForProxy.authMode, "apiKey");
    assert.equal(isFlatRateProvider("my-proxy", ctxForProxy), true);

    const ctxForOther = buildFlatRateContext("anthropic", ctx, prefs);
    assert.equal(ctxForOther.authMode, "apiKey");
    assert.equal(isFlatRateProvider("anthropic", ctxForOther), false);
  });

  test("survives missing ctx and missing prefs", () => {
    const empty = buildFlatRateContext("anything");
    assert.equal(empty.authMode, undefined);
    assert.equal(empty.userFlatRate, undefined);
    assert.equal(isFlatRateProvider("anything", empty), false);
  });

  test("survives a registry lookup that throws", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthMode: () => {
          throw new Error("registry boom");
        },
      },
    };
    const result = buildFlatRateContext("anything", ctx);
    // Error must be swallowed — authMode left undefined, function returns.
    assert.equal(result.authMode, undefined);
  });

  test("registry returning a non-canonical auth mode is ignored", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthMode: () => "weird-mode",
      },
    };
    const result = buildFlatRateContext("anything", ctx);
    assert.equal(result.authMode, undefined);
  });
});

// ─── #4386: allow_flat_rate_providers opt-in ────────────────────────────────

describe("flat-rate routing opt-in (#4386)", () => {
  function withPrefs(prefsYaml: string, fn: () => void): void {
    const originalCwd = process.cwd();
    const originalGsdHome = process.env.GSD_HOME;
    const tempProject = mkdtempSync(join(tmpdir(), "gsd-4386-project-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-4386-home-"));
    try {
      mkdirSync(join(tempProject, ".gsd"), { recursive: true });
      writeFileSync(
        join(tempProject, ".gsd", "PREFERENCES.md"),
        ["---", "version: 1", prefsYaml, "---"].join("\n"),
        "utf-8",
      );
      process.env.GSD_HOME = tempGsdHome;
      process.chdir(tempProject);
      fn();
    } finally {
      process.chdir(originalCwd);
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(tempProject, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  }

  test("default (opt-in absent): flat-rate start model still returns undefined", () => {
    withPrefs(
      [
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6",
      ].join("\n"),
      () => {
        const result = resolvePreferredModelConfig("execute-task", {
          provider: "claude-code",
          id: "claude-opus-4-6",
        });
        assert.equal(result, undefined, "default must preserve #3453 bypass");
      },
    );
  });

  test("opt-in: synthesizes a routing config for flat-rate start model", () => {
    withPrefs(
      [
        "dynamic_routing:",
        "  enabled: true",
        "  allow_flat_rate_providers: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6",
      ].join("\n"),
      () => {
        const result = resolvePreferredModelConfig("execute-task", {
          provider: "claude-code",
          id: "claude-opus-4-6",
        });
        assert.ok(result, "routing config should be synthesized");
        assert.equal(result!.primary, "claude-opus-4-6");
      },
    );
  });

  test("explicit opt-out: flat-rate bypass still fires", () => {
    withPrefs(
      [
        "dynamic_routing:",
        "  enabled: true",
        "  allow_flat_rate_providers: false",
        "  tier_models:",
        "    heavy: claude-opus-4-6",
      ].join("\n"),
      () => {
        const result = resolvePreferredModelConfig("execute-task", {
          provider: "claude-code",
          id: "claude-opus-4-6",
        });
        assert.equal(result, undefined, "explicit opt-out behaves like default");
      },
    );
  });
});

// ─── Banner transparency: auto-start respects the opt-in (#4386) ────────────

describe("auto-start banner respects allow_flat_rate_providers (#4386)", () => {
  test("banner expression gates flat-rate disable on allow_flat_rate_providers", () => {
    const src = readFileSync(
      join(__dirname_4386, "..", "auto-start.ts"),
      "utf-8",
    );
    assert.ok(
      src.includes("routingConfig.allow_flat_rate_providers"),
      "auto-start banner must read allow_flat_rate_providers so the banner reflects the opt-in",
    );
  });
});
