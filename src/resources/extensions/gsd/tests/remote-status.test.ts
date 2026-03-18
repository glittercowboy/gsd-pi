import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPromptRecord, writePromptRecord } from "../../remote-questions/mod.js";
import { getLatestPromptSummary } from "../../remote-questions/mod.js";

function withTempHome(fn: (tempHome: string) => void | Promise<void>) {
  return async () => {
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const tempHome = join(tmpdir(), `gsd-remote-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempHome, ".gsd", "runtime", "remote-questions"), { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    try {
      await fn(tempHome);
    } finally {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedUserProfile;
      rmSync(tempHome, { recursive: true, force: true });
    }
  };
}

test("getLatestPromptSummary returns latest stored prompt", withTempHome(() => {
  const recordA = createPromptRecord({
    id: "a-prompt",
    channel: "slack",
    createdAt: 1,
    timeoutAt: 10,
    pollIntervalMs: 5000,
    questions: [],
  });
  recordA.updatedAt = 1;
  writePromptRecord(recordA);

  const recordB = createPromptRecord({
    id: "z-prompt",
    channel: "discord",
    createdAt: 2,
    timeoutAt: 10,
    pollIntervalMs: 5000,
    questions: [],
  });
  recordB.updatedAt = 2;
  recordB.status = "answered";
  writePromptRecord(recordB);

  const latest = getLatestPromptSummary();
  assert.equal(latest?.id, "z-prompt");
  assert.equal(latest?.status, "answered");
}));

test("getLatestPromptSummary sorts by updatedAt, not filename", withTempHome(() => {
  // Record with alphabetically-LAST id but OLDEST timestamp
  const old = createPromptRecord({
    id: "zzz-oldest",
    channel: "slack",
    createdAt: 1000,
    timeoutAt: 9999,
    pollIntervalMs: 5000,
    questions: [],
  });
  old.updatedAt = 1000;
  writePromptRecord(old);

  // Record with alphabetically-FIRST id but NEWEST timestamp
  const newest = createPromptRecord({
    id: "aaa-newest",
    channel: "discord",
    createdAt: 3000,
    timeoutAt: 9999,
    pollIntervalMs: 5000,
    questions: [],
  });
  newest.updatedAt = 3000;
  newest.status = "answered";
  writePromptRecord(newest);

  // Record in between
  const middle = createPromptRecord({
    id: "mmm-middle",
    channel: "slack",
    createdAt: 2000,
    timeoutAt: 9999,
    pollIntervalMs: 5000,
    questions: [],
  });
  middle.updatedAt = 2000;
  writePromptRecord(middle);

  const latest = getLatestPromptSummary();
  // Should return "aaa-newest" (updatedAt=3000), NOT "zzz-oldest" (alphabetically last)
  assert.equal(latest?.id, "aaa-newest", "should pick the most recently updated prompt, not the alphabetically last filename");
  assert.equal(latest?.status, "answered");
  assert.equal(latest?.updatedAt, 3000);
}));
