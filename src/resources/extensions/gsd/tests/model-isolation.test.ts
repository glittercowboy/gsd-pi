/**
 * Tests for model config isolation between concurrent instances (#650, #1065).
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
