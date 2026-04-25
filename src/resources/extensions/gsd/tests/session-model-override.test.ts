import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearSessionModelOverride,
  getSessionModelOverride,
  setSessionModelOverride,
} from "../session-model-override.js";

const phasesSource = readFileSync(join(import.meta.dirname, "..", "auto", "phases.ts"), "utf-8");

test("setSessionModelOverride stores provider/model for the session", () => {
  const sessionId = `session-override-${Date.now()}`;
  setSessionModelOverride(sessionId, { provider: "openai-codex", id: "gpt-5.4" });

  const override = getSessionModelOverride(sessionId);
  assert.equal(override?.provider, "openai-codex");
  assert.equal(override?.id, "gpt-5.4");
});

test("clearSessionModelOverride removes the session override", () => {
  const sessionId = `session-clear-${Date.now()}`;
  setSessionModelOverride(sessionId, { provider: "anthropic", id: "claude-sonnet-4-6" });
  clearSessionModelOverride(sessionId);
  assert.equal(getSessionModelOverride(sessionId), undefined);
});

test("auto dispatch threads manual session model override into selectAndApplyModel", () => {
  assert.ok(
    phasesSource.includes("s.manualSessionModelOverride"),
    "auto/phases.ts should pass s.manualSessionModelOverride into selectAndApplyModel",
  );
});
