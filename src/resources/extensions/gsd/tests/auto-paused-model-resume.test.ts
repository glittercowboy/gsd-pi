import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  snapshotPausedModelMetadata,
  restoreModelSnapshotFromPausedMetadata,
  applyPausedModelSnapshot,
  backfillMissingPausedModelSnapshot,
  attemptRestoreOriginalModelForPausedInteraction,
} from "../auto/paused-model-snapshot.ts";
import { readPausedSessionMetadata, type PausedSessionMetadata } from "../interrupted-session.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-paused-model-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("pause metadata snapshot persists model fields without sharing object references", () => {
  const sessionState = {
    autoModeStartModel: { provider: "anthropic", id: "claude-3-5-sonnet" },
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
  };

  const metadata = snapshotPausedModelMetadata(sessionState);

  assert.deepEqual(metadata, {
    autoModeStartModel: { provider: "anthropic", id: "claude-3-5-sonnet" },
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
  });

  // Ensure snapshot output is not an alias of mutable session state.
  metadata.autoModeStartModel!.id = "mutated-in-test";
  assert.equal(sessionState.autoModeStartModel.id, "claude-3-5-sonnet");
});

test("resume snapshot restoration only accepts valid persisted metadata", () => {
  const validMeta: PausedSessionMetadata = {
    autoModeStartModel: { provider: "anthropic", id: "claude-opus-4-1" },
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
  };

  const restored = restoreModelSnapshotFromPausedMetadata(validMeta);
  assert.deepEqual(restored, {
    autoModeStartModel: { provider: "anthropic", id: "claude-opus-4-1" },
    originalModel: { provider: "openai", id: "gpt-4.1" },
  });

  const invalidMeta = {
    autoModeStartModel: { provider: "anthropic", id: 42 },
    originalModelProvider: "openai",
    originalModelId: null,
  } as unknown as PausedSessionMetadata;

  const invalidRestored = restoreModelSnapshotFromPausedMetadata(invalidMeta);
  assert.equal(invalidRestored.autoModeStartModel, null);
  assert.equal(invalidRestored.originalModel, null);
});

test("legacy paused-session metadata without model fields resumes with current model fallback", () => {
  const base = makeTmpBase();

  try {
    writeFileSync(
      join(base, ".gsd", "runtime", "paused-session.json"),
      JSON.stringify({
        milestoneId: "M001",
        originalBasePath: base,
        stepMode: false,
        pausedAt: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );

    const meta = readPausedSessionMetadata(base);
    const restored = restoreModelSnapshotFromPausedMetadata(meta);
    assert.deepEqual(restored, {
      autoModeStartModel: null,
      originalModel: null,
    });

    const state = {
      autoModeStartModel: null,
      originalModelProvider: null,
      originalModelId: null,
    };
    applyPausedModelSnapshot(state, restored);
    backfillMissingPausedModelSnapshot(state, {
      provider: "openai",
      id: "gpt-4.1",
    });

    assert.deepEqual(state, {
      autoModeStartModel: { provider: "openai", id: "gpt-4.1" },
      originalModelProvider: "openai",
      originalModelId: "gpt-4.1",
    });
  } finally {
    cleanup(base);
  }
});

test("resume snapshot apply mutates only when restored values are present", () => {
  const state = {
    autoModeStartModel: { provider: "x", id: "old-auto" },
    originalModelProvider: "y",
    originalModelId: "old-original",
  };

  applyPausedModelSnapshot(state, {
    autoModeStartModel: null,
    originalModel: null,
  });

  assert.deepEqual(state, {
    autoModeStartModel: { provider: "x", id: "old-auto" },
    originalModelProvider: "y",
    originalModelId: "old-original",
  });

  applyPausedModelSnapshot(state, {
    autoModeStartModel: { provider: "anthropic", id: "claude-3-7-sonnet" },
    originalModel: { provider: "openai", id: "gpt-4.1" },
  });

  assert.deepEqual(state, {
    autoModeStartModel: { provider: "anthropic", id: "claude-3-7-sonnet" },
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
  });
});

test("user-initiated resume backfills model snapshot fields only when missing", () => {
  const existing = {
    autoModeStartModel: { provider: "anthropic", id: "existing-auto" },
    originalModelProvider: "openai",
    originalModelId: "existing-original",
  };

  backfillMissingPausedModelSnapshot(existing, {
    provider: "google",
    id: "gemini-2.5-pro",
  });

  assert.deepEqual(existing, {
    autoModeStartModel: { provider: "anthropic", id: "existing-auto" },
    originalModelProvider: "openai",
    originalModelId: "existing-original",
  });

  const missing = {
    autoModeStartModel: null,
    originalModelProvider: null,
    originalModelId: null,
  };

  backfillMissingPausedModelSnapshot(missing, {
    provider: "google",
    id: "gemini-2.5-pro",
  });

  assert.deepEqual(missing, {
    autoModeStartModel: { provider: "google", id: "gemini-2.5-pro" },
    originalModelProvider: "google",
    originalModelId: "gemini-2.5-pro",
  });
});

test("paused model restore attempts setModel with persist:false and reports result", async () => {
  const calls: Array<{ model: unknown; options: { persist: false } }> = [];
  const targetModel = { provider: "openai", id: "gpt-4.1" };

  const restored = await attemptRestoreOriginalModelForPausedInteraction({
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
    findModel: () => targetModel,
    setModel: async (model, options) => {
      calls.push({ model, options });
      return true;
    },
  });

  assert.deepEqual(restored, { status: "restored" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, targetModel);
  assert.deepEqual(calls[0].options, { persist: false });

  const setModelFalse = await attemptRestoreOriginalModelForPausedInteraction({
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
    findModel: () => targetModel,
    setModel: async () => false,
  });
  assert.deepEqual(setModelFalse, { status: "set-model-false" });

  const notFound = await attemptRestoreOriginalModelForPausedInteraction({
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
    findModel: () => null,
    setModel: async () => true,
  });
  assert.deepEqual(notFound, { status: "not-found" });
});

test("paused model restore returns skipped or error for non-restorable cases", async () => {
  const skipped = await attemptRestoreOriginalModelForPausedInteraction({
    originalModelProvider: null,
    originalModelId: null,
    findModel: null,
    setModel: null,
  });
  assert.deepEqual(skipped, { status: "skipped" });

  const thrown = await attemptRestoreOriginalModelForPausedInteraction({
    originalModelProvider: "openai",
    originalModelId: "gpt-4.1",
    findModel: () => ({ provider: "openai", id: "gpt-4.1" }),
    setModel: async () => {
      throw new Error("simulated failure");
    },
  });

  assert.equal(thrown.status, "error");
  assert.match(String(thrown.error), /simulated failure/);
});
