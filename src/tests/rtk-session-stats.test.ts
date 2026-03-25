import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearRtkSessionBaseline,
  ensureRtkSessionBaseline,
  formatRtkSavingsLabel,
  getRtkSessionSavings,
} from "../resources/extensions/shared/rtk-session-stats.ts";
import { createFakeRtk } from "./rtk-test-utils.ts";

function summary(totalCommands: number, totalInput: number, totalOutput: number, totalSaved: number, totalTimeMs = 1000) {
  return JSON.stringify({
    summary: {
      total_commands: totalCommands,
      total_input: totalInput,
      total_output: totalOutput,
      total_saved: totalSaved,
      avg_savings_pct: totalInput > 0 ? (totalSaved / totalInput) * 100 : 0,
      total_time_ms: totalTimeMs,
      avg_time_ms: totalCommands > 0 ? totalTimeMs / totalCommands : 0,
    },
  });
}

test("RTK session savings diff from a persisted baseline", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-rtk-session-stats-"));
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });

  const first = createFakeRtk({
    "gain --all --format json": { stdout: summary(10, 1000, 600, 400) },
  });
  const second = createFakeRtk({
    "gain --all --format json": { stdout: summary(14, 1600, 900, 700, 1800) },
  });

  const previous = process.env.GSD_RTK_PATH;
  try {
    process.env.GSD_RTK_PATH = first.path;
    ensureRtkSessionBaseline(basePath, "sess-1");

    process.env.GSD_RTK_PATH = second.path;
    const savings = getRtkSessionSavings(basePath, "sess-1");
    assert.ok(savings, "expected RTK savings snapshot");
    assert.equal(savings?.commands, 4);
    assert.equal(savings?.inputTokens, 600);
    assert.equal(savings?.outputTokens, 300);
    assert.equal(savings?.savedTokens, 300);
    assert.equal(Math.round(savings?.savingsPct ?? 0), 50);
  } finally {
    if (previous === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previous;
    first.cleanup();
    second.cleanup();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("RTK session savings baseline resets cleanly when tracking totals go backwards", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-rtk-session-reset-"));
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });

  const first = createFakeRtk({
    "gain --all --format json": { stdout: summary(8, 800, 500, 300) },
  });
  const second = createFakeRtk({
    "gain --all --format json": { stdout: summary(1, 100, 80, 20) },
  });

  const previous = process.env.GSD_RTK_PATH;
  try {
    process.env.GSD_RTK_PATH = first.path;
    ensureRtkSessionBaseline(basePath, "sess-2");

    process.env.GSD_RTK_PATH = second.path;
    const savings = getRtkSessionSavings(basePath, "sess-2");
    assert.ok(savings, "expected RTK savings snapshot");
    assert.equal(savings?.commands, 0);
    assert.equal(savings?.savedTokens, 0);
  } finally {
    if (previous === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previous;
    first.cleanup();
    second.cleanup();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("formatRtkSavingsLabel produces a compact footer string", () => {
  assert.equal(
    formatRtkSavingsLabel({
      commands: 5,
      inputTokens: 5949,
      outputTokens: 2905,
      savedTokens: 3044,
      savingsPct: 51.2,
      totalTimeMs: 3200,
      avgTimeMs: 640,
      updatedAt: new Date().toISOString(),
    }),
    "rtk: 3.0k saved (51%)",
  );
  assert.equal(formatRtkSavingsLabel(null), null);
});

test("clearRtkSessionBaseline removes a stored session entry", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-rtk-session-clear-"));
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });
  const fake = createFakeRtk({
    "gain --all --format json": { stdout: summary(3, 300, 200, 100) },
  });
  const previous = process.env.GSD_RTK_PATH;

  try {
    process.env.GSD_RTK_PATH = fake.path;
    ensureRtkSessionBaseline(basePath, "sess-clear");
    clearRtkSessionBaseline(basePath, "sess-clear");
    const savings = getRtkSessionSavings(basePath, "sess-clear");
    assert.ok(savings, "expected savings snapshot after baseline recreation");
    assert.equal(savings?.commands, 0);
  } finally {
    if (previous === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previous;
    fake.cleanup();
    rmSync(basePath, { recursive: true, force: true });
  }
});
