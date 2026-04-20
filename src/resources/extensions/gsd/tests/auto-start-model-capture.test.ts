import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourcePath = join(import.meta.dirname, "..", "auto-start.ts");
const source = readFileSync(sourcePath, "utf-8");

test("bootstrapAutoSession snapshots ctx.model before guided-flow entry (#2829)", () => {
  // The snapshot ordering guarantee still holds: build snapshot before guided-flow.
  const snapshotIdx = source.indexOf("const startModelSnapshot = manualSessionOverride");
  assert.ok(snapshotIdx > -1, "auto-start.ts should snapshot model at bootstrap start");

  const firstDiscussIdx = source.indexOf('await showSmartEntry(ctx, pi, base, { step: requestedStepMode });');
  assert.ok(firstDiscussIdx > -1, "auto-start.ts should route through showSmartEntry during guided flow");

  assert.ok(
    snapshotIdx < firstDiscussIdx,
    "auto-start.ts must capture the start model before guided-flow can mutate ctx.model",
  );
});

test("bootstrapAutoSession restores autoModeStartModel from the early snapshot (#2829)", () => {
  const assignmentIdx = source.indexOf("s.autoModeStartModel = {");
  assert.ok(assignmentIdx > -1, "auto-start.ts should assign autoModeStartModel");

  const snapshotRefIdx = source.indexOf("provider: startModelSnapshot.provider", assignmentIdx);
  assert.ok(snapshotRefIdx > -1, "autoModeStartModel should be restored from startModelSnapshot");
});

test("bootstrapAutoSession checks manual session override before preferences", () => {
  const manualIdx = source.indexOf("const manualSessionOverride = getSessionModelOverride(");
  assert.ok(manualIdx > -1, "auto-start.ts should read session model override first");

  // resolveDefaultSessionModel() should still be called for fallback behavior
  const preferredIdx = source.indexOf("const preferredModel = ");
  assert.ok(preferredIdx > -1, "auto-start.ts should build preferredModel");
  assert.ok(
    source.indexOf("resolveDefaultSessionModel(") > -1,
    "auto-start.ts should call resolveDefaultSessionModel()",
  );

  // Session provider should be passed for bare model ID resolution
  const withProviderIdx = source.indexOf("resolveDefaultSessionModel(ctx.model?.provider)");
  assert.ok(withProviderIdx > -1, "auto-start.ts should pass ctx.model?.provider for bare ID resolution");

  const snapshotIdx = source.indexOf("const startModelSnapshot = manualSessionOverride");
  assert.ok(snapshotIdx > -1, "startModelSnapshot should prefer manual session override");

  assert.ok(
    manualIdx < snapshotIdx && preferredIdx < snapshotIdx,
    "manual override and preference fallback must be resolved before building startModelSnapshot",
  );

  // Preferred model should still be part of fallback resolution.
  const snapshotBlock = source.slice(snapshotIdx, snapshotIdx + 400);
  assert.ok(
    snapshotBlock.includes("validatedPreferredModel") || snapshotBlock.includes("preferredModel"),
    "startModelSnapshot must still consider preferredModel for built-in providers",
  );
});

test("bootstrapAutoSession prioritizes current session model over PREFERENCES.md default", () => {
  const snapshotIdx = source.indexOf("const startModelSnapshot = manualSessionOverride");
  assert.ok(snapshotIdx > -1, "auto-start.ts should build startModelSnapshot");

  const snapshotBlock = source.slice(snapshotIdx, snapshotIdx + 500);
  const currentIdx = snapshotBlock.indexOf("currentSessionModel");
  const preferredIdx = snapshotBlock.indexOf("validatedPreferredModel");

  assert.ok(currentIdx > -1, "startModelSnapshot should include currentSessionModel");
  assert.ok(preferredIdx > -1, "startModelSnapshot should include validatedPreferredModel");
  assert.ok(
    currentIdx < preferredIdx,
    "startModelSnapshot should prefer currentSessionModel before validatedPreferredModel",
  );
});

test("bootstrapAutoSession prefers session model over PREFERENCES.md when provider is custom (#4122)", () => {
  // Custom providers (Ollama, vLLM, OpenAI-compatible proxies) live in
  // ~/.gsd/agent/models.json, not PREFERENCES.md.  When the user picks one
  // via /gsd model, that selection must win over any preferredModel from
  // PREFERENCES.md, otherwise auto-mode tries to start a built-in provider
  // the user is not logged into and pauses with "Not logged in".
  const customCheckIdx = source.indexOf("isCustomProvider(ctx.model?.provider)");
  assert.ok(
    customCheckIdx > -1,
    "auto-start.ts should call isCustomProvider() to detect custom-model sessions",
  );

  // sessionProviderIsCustom must gate preferredModel resolution so that when the
  // session provider is custom, preferredModel is null and PREFERENCES.md is
  // skipped entirely — the snapshot then falls through to ctx.model.
  const gateIdx = source.indexOf("sessionProviderIsCustom");
  assert.ok(gateIdx > -1, "auto-start.ts should bind sessionProviderIsCustom");

  const preferredIdx = source.indexOf("const preferredModel = ");
  assert.ok(preferredIdx > -1, "auto-start.ts should build preferredModel");

  const preferredBlock = source.slice(preferredIdx, preferredIdx + 200);
  assert.ok(
    preferredBlock.includes("sessionProviderIsCustom"),
    "preferredModel must be gated on sessionProviderIsCustom so PREFERENCES.md is skipped for custom providers",
  );

  const snapshotIdx = source.indexOf("const startModelSnapshot = ");
  assert.ok(snapshotIdx > -1, "auto-start.ts should build startModelSnapshot");

  assert.ok(
    customCheckIdx < preferredIdx && preferredIdx < snapshotIdx,
    "isCustomProvider() must be evaluated before preferredModel, which must be resolved before startModelSnapshot",
  );
});

test("bootstrapAutoSession validates preferred model against live registry auth (#unconfigured-models)", () => {
  // The raw PREFERENCES.md value must be validated against getAvailable()
  // before being captured as the snapshot, so an unconfigured provider
  // (no API key / OAuth) can't become autoModeStartModel.
  const validationIdx = source.indexOf("ctx.modelRegistry.getAvailable()");
  assert.ok(validationIdx > -1, "auto-start.ts should validate preferred model against getAvailable()");

  const resolveModelIdIdx = source.indexOf("resolveModelId");
  assert.ok(resolveModelIdIdx > -1, "auto-start.ts should resolve preferred model against the registry");

  const warningIdx = source.indexOf("is not configured; falling back to session default");
  assert.ok(warningIdx > -1, "auto-start.ts should warn when preferred model is unconfigured");
});

test("bootstrapAutoSession snapshots and persists thinking level for auto-mode lifecycle", () => {
  const captureIdx = source.indexOf("const startThinkingSnapshot = pi.getThinkingLevel()");
  assert.ok(captureIdx > -1, "auto-start.ts should snapshot thinking level at bootstrap start");

  const originalThinkingIdx = source.indexOf("s.originalThinkingLevel = startThinkingSnapshot ?? null");
  assert.ok(originalThinkingIdx > -1, "auto-start.ts should store originalThinkingLevel from snapshot");

  const autoThinkingIdx = source.indexOf("s.autoModeStartThinkingLevel = startThinkingSnapshot ?? null");
  assert.ok(autoThinkingIdx > -1, "auto-start.ts should store autoModeStartThinkingLevel from snapshot");

  assert.ok(
    captureIdx < originalThinkingIdx && captureIdx < autoThinkingIdx,
    "thinking snapshot must be captured before session state assignment",
  );
});
