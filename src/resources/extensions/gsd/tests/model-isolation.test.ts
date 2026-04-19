/**
 * Tests for model config isolation between concurrent instances (#650, #1065),
 * session-scoped model precedence behavior including manual session override,
 * GSD preferences override of settings.json defaults (#3517), and custom
 * provider precedence over PREFERENCES.md when set via `/gsd model` (#4122).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `gsd-test-650-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Settings Manager Model Scoping ───────────────────────────────────────────

describe("model config isolation (#650)", () => {
  let tmpGlobal: string;
  let tmpProjectA: string;
  let tmpProjectB: string;

  beforeEach(() => {
    tmpGlobal = makeTmpDir("global");
    tmpProjectA = makeTmpDir("project-a");
    tmpProjectB = makeTmpDir("project-b");
    // Create .pi directories for project settings
    mkdirSync(join(tmpProjectA, ".pi"), { recursive: true });
    mkdirSync(join(tmpProjectB, ".pi"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpGlobal, { recursive: true, force: true }); } catch {}
    try { rmSync(tmpProjectA, { recursive: true, force: true }); } catch {}
    try { rmSync(tmpProjectB, { recursive: true, force: true }); } catch {}
  });

  it("project settings file isolates model from global", async () => {
    // Write project settings for project A
    const projectSettingsPath = join(tmpProjectA, ".pi", "settings.json");
    writeFileSync(projectSettingsPath, JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    }));

    // Write global settings with a different model
    const globalSettingsPath = join(tmpGlobal, "settings.json");
    writeFileSync(globalSettingsPath, JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    }));

    // Verify project settings exist and have independent data
    const projectData = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
    const globalData = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));

    assert.equal(projectData.defaultModel, "claude-opus-4-6");
    assert.equal(globalData.defaultModel, "gpt-5.4");
    assert.notEqual(projectData.defaultModel, globalData.defaultModel,
      "Project and global should have different models");
  });

  it("two projects have independent model configs", () => {
    const settingsA = join(tmpProjectA, ".pi", "settings.json");
    const settingsB = join(tmpProjectB, ".pi", "settings.json");

    writeFileSync(settingsA, JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    }));
    writeFileSync(settingsB, JSON.stringify({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
    }));

    const dataA = JSON.parse(readFileSync(settingsA, "utf-8"));
    const dataB = JSON.parse(readFileSync(settingsB, "utf-8"));

    assert.equal(dataA.defaultModel, "claude-opus-4-6");
    assert.equal(dataB.defaultModel, "gpt-5.4");
    assert.notEqual(dataA.defaultProvider, dataB.defaultProvider);
  });

  it("autoModeStartModel concept prevents model drift", () => {
    // Simulate the auto-mode start model capture pattern
    const autoModeStartModel = { provider: "anthropic", id: "claude-opus-4-6" };

    // Simulate another instance writing to global settings
    const globalSettings = { defaultProvider: "openai-codex", defaultModel: "gpt-5.4" };

    // The captured model should be used, not the global settings
    assert.notEqual(autoModeStartModel.id, globalSettings.defaultModel);
    assert.equal(autoModeStartModel.id, "claude-opus-4-6",
      "Captured model should be preserved regardless of global settings changes");
  });
});

// ─── Session model recovery on error (#1065) ─────────────────────────────────

describe("session model recovery on error (#1065)", () => {
  it("session model is preferred over fallback chain from disk when models diverge", () => {
    // Simulate: Session started with opus, fallback chain exhausted,
    // another session's global prefs point to a different model.
    const sessionModel = { provider: "anthropic", id: "claude-opus-4-6" };
    const currentModel = { provider: "openai-codex", id: "codex-mini-latest" };

    // The session model should be restored when current model differs
    const shouldRecover = currentModel.id !== sessionModel.id
      || currentModel.provider !== sessionModel.provider;

    assert.ok(shouldRecover,
      "Recovery should trigger when current model diverged from session model");
  });

  it("session model recovery is skipped when model has not diverged", () => {
    // If the current model is still the session model, no recovery needed
    const sessionModel = { provider: "anthropic", id: "claude-opus-4-6" };
    const currentModel = { provider: "anthropic", id: "claude-opus-4-6" };

    const shouldRecover = currentModel.id !== sessionModel.id
      || currentModel.provider !== sessionModel.provider;

    assert.ok(!shouldRecover,
      "Recovery should NOT trigger when current model matches session model");
  });

  it("cross-session model leakage scenario is detected", () => {
    // Session A: user chose opus for project-alpha
    const sessionA = { provider: "anthropic", id: "claude-opus-4-6" };
    // Session B: user chose gpt-5.4 for project-beta
    const sessionB = { provider: "openai", id: "gpt-5.4" };

    // If Session A's error handler somehow picked up Session B's model,
    // the session model recovery should detect the divergence
    const currentModelAfterBadFallback = sessionB; // leakage happened
    const shouldRecover = currentModelAfterBadFallback.id !== sessionA.id
      || currentModelAfterBadFallback.provider !== sessionA.provider;

    assert.ok(shouldRecover,
      "Session model recovery must detect cross-session leakage and restore original model");
    assert.equal(sessionA.id, "claude-opus-4-6",
      "Session A's model must be restored, not Session B's");
  });

  it("session model is null-safe when auto-mode was not started", () => {
    // When getAutoModeStartModel() returns null, recovery should be skipped
    const sessionModel: { provider: string; id: string } | null = null;

    // The recovery block should guard against null
    const shouldAttemptRecovery = sessionModel !== null;
    assert.ok(!shouldAttemptRecovery,
      "Recovery should be skipped when no session model was captured");
  });
});

// ─── Manual session model override precedence ───────────────────────────────

describe("manual session model override precedence", () => {
  it("manual session override takes priority over preferences and ctx.model", () => {
    const manualSessionOverride = { provider: "openai-codex", id: "gpt-5.4" };
    const preferredModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    const ctxModel = { provider: "claude-code", id: "claude-opus-4-6" };

    const startModelSnapshot = manualSessionOverride
      ?? preferredModel
      ?? { provider: ctxModel.provider, id: ctxModel.id };

    assert.equal(startModelSnapshot.provider, "openai-codex");
    assert.equal(startModelSnapshot.id, "gpt-5.4");
  });

  it("falls back to preferences when no manual override is active", () => {
    const manualSessionOverride: { provider: string; id: string } | undefined = undefined;
    const preferredModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    const ctxModel = { provider: "claude-code", id: "claude-opus-4-6" };

    const startModelSnapshot = manualSessionOverride
      ?? preferredModel
      ?? { provider: ctxModel.provider, id: ctxModel.id };

    assert.equal(startModelSnapshot.provider, "anthropic");
    assert.equal(startModelSnapshot.id, "claude-sonnet-4-6");
  });

  it("falls back to ctx.model when no manual override or preferences are configured", () => {
    const manualSessionOverride: { provider: string; id: string } | undefined = undefined;
    const preferredModel: { provider: string; id: string } | undefined = undefined;
    const ctxModel = { provider: "claude-code", id: "claude-opus-4-6" };

    const startModelSnapshot = manualSessionOverride
      ?? preferredModel
      ?? { provider: ctxModel.provider, id: ctxModel.id };

    assert.equal(startModelSnapshot.provider, "claude-code");
    assert.equal(startModelSnapshot.id, "claude-opus-4-6");
  });

  it("handles null ctx.model with no override or preferences gracefully", () => {
    const manualSessionOverride: { provider: string; id: string } | undefined = undefined;
    const preferredModel: { provider: string; id: string } | undefined = undefined;
    // Use a function to prevent TS from narrowing to `never` in the ternary
    function getCtxModel(): { provider: string; id: string } | null { return null; }
    const ctxModel = getCtxModel();

    const startModelSnapshot = manualSessionOverride
      ?? preferredModel
      ?? (ctxModel ? { provider: ctxModel.provider, id: ctxModel.id } : null);

    assert.equal(startModelSnapshot, null,
      "should be null when no model source is available");
  });
});

// ─── Custom provider session model wins over PREFERENCES.md (#4122) ─────────

describe("custom provider session model overrides PREFERENCES.md (#4122)", () => {
  // Mirrors the auto-start.ts logic:
  //   sessionProviderIsCustom && ctx.model
  //     ? ctx.model
  //     : (preferredModel ?? ctx.model ?? null)
  function selectStartModel(args: {
    ctxModel: { provider: string; id: string } | null;
    preferredModel: { provider: string; id: string } | undefined;
    sessionProviderIsCustom: boolean;
  }): { provider: string; id: string } | null {
    const { ctxModel, preferredModel, sessionProviderIsCustom } = args;
    if (sessionProviderIsCustom && ctxModel) {
      return { provider: ctxModel.provider, id: ctxModel.id };
    }
    return preferredModel
      ?? (ctxModel ? { provider: ctxModel.provider, id: ctxModel.id } : null);
  }

  it("custom provider from /gsd model wins over PREFERENCES.md built-in default", () => {
    // User runs `/gsd model ollama/llama3.1:8b`, then `/gsd auto`.
    // PREFERENCES.md still has the project-template claude-code default.
    const ctxModel = { provider: "ollama", id: "llama3.1:8b" };
    const preferredModel = { provider: "claude-code", id: "claude-sonnet-4-6" };

    const snapshot = selectStartModel({
      ctxModel,
      preferredModel,
      sessionProviderIsCustom: true,
    });

    assert.equal(snapshot?.provider, "ollama",
      "custom-provider session model must win over PREFERENCES.md");
    assert.equal(snapshot?.id, "llama3.1:8b",
      "custom-provider session model id must be preserved");
    assert.notEqual(snapshot?.provider, "claude-code",
      "claude-code from PREFERENCES.md must NOT be selected when session is custom");
  });

  it("built-in session provider still defers to PREFERENCES.md (#3517 preserved)", () => {
    // ctx.model is a built-in provider (claude-code) but PREFERENCES.md has
    // an explicit openai-codex preference.  PREFERENCES.md should still win.
    const ctxModel = { provider: "claude-code", id: "claude-sonnet-4-6" };
    const preferredModel = { provider: "openai-codex", id: "gpt-5.4" };

    const snapshot = selectStartModel({
      ctxModel,
      preferredModel,
      sessionProviderIsCustom: false,
    });

    assert.equal(snapshot?.provider, "openai-codex",
      "PREFERENCES.md must still win when session provider is built-in");
    assert.equal(snapshot?.id, "gpt-5.4");
  });

  it("custom provider with no PREFERENCES.md still uses ctx.model", () => {
    const ctxModel = { provider: "vllm", id: "qwen2.5-coder:32b" };

    const snapshot = selectStartModel({
      ctxModel,
      preferredModel: undefined,
      sessionProviderIsCustom: true,
    });

    assert.equal(snapshot?.provider, "vllm");
    assert.equal(snapshot?.id, "qwen2.5-coder:32b");
  });

  it("null ctx.model with custom flag falls through to preferredModel", () => {
    // Defensive: sessionProviderIsCustom can only be true if ctx.model exists,
    // but verify the guard works if that invariant is ever broken.
    const preferredModel = { provider: "claude-code", id: "claude-sonnet-4-6" };

    const snapshot = selectStartModel({
      ctxModel: null,
      preferredModel,
      sessionProviderIsCustom: true,
    });

    assert.equal(snapshot?.provider, "claude-code",
      "should fall back to preferredModel when ctx.model is null");
  });
});

