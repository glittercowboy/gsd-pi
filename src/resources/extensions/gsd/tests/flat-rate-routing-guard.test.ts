/**
 * Regression test for #3453: dynamic model routing must be disabled for
 * flat-rate providers like GitHub Copilot where all models cost the same
 * per request — routing only degrades quality with no cost benefit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildFlatRateContext, isFlatRateProvider, resolvePreferredModelConfig } from "../auto-model-selection.ts";

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
    // Isolate from user's real ~/.gsd/preferences.md via GSD_HOME
    const savedGsdHome = process.env.GSD_HOME;
    const savedHome = process.env.HOME;
    try {
      process.env.GSD_HOME = "/tmp/gsd-no-such-home-for-test-flat-rate";
      process.env.HOME = "/tmp/gsd-no-such-home-for-test-flat-rate";
      const result = resolvePreferredModelConfig("execute-task", {
        provider: "github-copilot",
        id: "claude-sonnet-4",
      });

      // Should be undefined (no routing config created for flat-rate)
      // Note: this only tests the guard — if explicit per-unit config exists
      // in preferences, that takes precedence regardless.
      assert.equal(result, undefined, "Should not create routing config for copilot");
    } finally {
      if (savedGsdHome !== undefined) process.env.GSD_HOME = savedGsdHome;
      else delete process.env.GSD_HOME;
      process.env.HOME = savedHome;
    }
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
  // pi 0.67.2 removed getProviderAuthMode from ModelRegistry.
  // buildFlatRateContext now detects externalCli via getAll() + local:// baseUrl.

  test("detects externalCli from local:// baseUrl via getAll()", () => {
    const ctx = {
      modelRegistry: {
        getAll: () => [
          { provider: "my-cli", baseUrl: "local://my-cli" },
          { provider: "anthropic", baseUrl: "https://api.anthropic.com" },
        ],
      },
    };
    const prefs = { flat_rate_providers: ["my-proxy"] };

    const ctxForCli = buildFlatRateContext("my-cli", ctx, prefs);
    assert.equal(ctxForCli.authMode, "externalCli");
    assert.deepEqual(ctxForCli.userFlatRate, ["my-proxy"]);
    assert.equal(isFlatRateProvider("my-cli", ctxForCli), true);

    // my-proxy is flat-rate via userFlatRate, not authMode
    const ctxForProxy = buildFlatRateContext("my-proxy", ctx, prefs);
    assert.equal(ctxForProxy.authMode, undefined);
    assert.equal(isFlatRateProvider("my-proxy", ctxForProxy), true);

    // anthropic has https baseUrl, not externalCli
    const ctxForOther = buildFlatRateContext("anthropic", ctx, prefs);
    assert.equal(ctxForOther.authMode, undefined);
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
        getAll: () => {
          throw new Error("registry boom");
        },
      },
    };
    const result = buildFlatRateContext("anything", ctx);
    // Error must be swallowed — authMode left undefined, function returns.
    assert.equal(result.authMode, undefined);
  });

  test("non-local baseUrl does not produce externalCli", () => {
    const ctx = {
      modelRegistry: {
        getAll: () => [
          { provider: "anything", baseUrl: "https://api.example.com" },
        ],
      },
    };
    const result = buildFlatRateContext("anything", ctx);
    assert.equal(result.authMode, undefined);
  });
});
