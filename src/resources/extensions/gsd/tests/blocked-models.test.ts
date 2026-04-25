// GSD — Tests for persistent blocked-models store (issue #4513)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  blockModel,
  isModelBlocked,
  loadBlockedModels,
} from "../blocked-models.ts";

function mkBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-blocked-models-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

test("blocked-models: round-trip write and read", () => {
  const base = mkBase();
  try {
    assert.equal(isModelBlocked(base, "openai-codex", "gpt-5.1-codex-max"), false);
    blockModel(base, "openai-codex", "gpt-5.1-codex-max", "not supported for ChatGPT account");
    assert.equal(isModelBlocked(base, "openai-codex", "gpt-5.1-codex-max"), true);

    const entries = loadBlockedModels(base);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].provider, "openai-codex");
    assert.equal(entries[0].id, "gpt-5.1-codex-max");
    assert.ok(entries[0].blockedAt > 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("blocked-models: case-insensitive lookup", () => {
  const base = mkBase();
  try {
    blockModel(base, "OpenAI-Codex", "GPT-5.1-Codex-Max", "reason");
    assert.equal(isModelBlocked(base, "openai-codex", "gpt-5.1-codex-max"), true);
    assert.equal(isModelBlocked(base, "OPENAI-CODEX", "GPT-5.1-CODEX-MAX"), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("blocked-models: dedupes repeated blocks", () => {
  const base = mkBase();
  try {
    blockModel(base, "openai-codex", "gpt-5", "first");
    blockModel(base, "openai-codex", "gpt-5", "second");
    blockModel(base, "openai-codex", "gpt-5", "third");
    assert.equal(loadBlockedModels(base).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("blocked-models: corrupted JSON recovers to empty", () => {
  const base = mkBase();
  try {
    const path = join(base, ".gsd", "runtime", "blocked-models.json");
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(path, "{not valid json", "utf-8");

    assert.equal(loadBlockedModels(base).length, 0);
    assert.equal(isModelBlocked(base, "any", "model"), false);

    // A subsequent write should still succeed (overwrites the corrupt file).
    blockModel(base, "openai-codex", "gpt-5", "reason");
    assert.equal(loadBlockedModels(base).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("blocked-models: returns false for missing provider or id", () => {
  const base = mkBase();
  try {
    blockModel(base, "openai-codex", "gpt-5", "reason");
    assert.equal(isModelBlocked(base, undefined, "gpt-5"), false);
    assert.equal(isModelBlocked(base, "openai-codex", undefined), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("blocked-models: file created under .gsd/runtime/", () => {
  const base = mkBase();
  try {
    blockModel(base, "openai-codex", "gpt-5", "reason");
    assert.ok(existsSync(join(base, ".gsd", "runtime", "blocked-models.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
