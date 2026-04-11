import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearRtkSessionBaseline,
  ensureRtkSessionBaseline,
  formatRtkSavingsLabel,
  getRtkSessionSavings,
} from "../resources/extensions/shared/rtk-session-stats.ts";
import { createFakeRtk } from "./rtk-test-utils.ts";

// Store original env values for restoration
let originalRtkDisabled: string | undefined;

beforeEach(() => {
  // Save and clear GSD_RTK_DISABLED so tests can use fake RTK binaries
  originalRtkDisabled = process.env.GSD_RTK_DISABLED;
  delete process.env.GSD_RTK_DISABLED;
});

afterEach(() => {
  // Restore original env
  if (originalRtkDisabled !== undefined) {
    process.env.GSD_RTK_DISABLED = originalRtkDisabled;
  } else {
    delete process.env.GSD_RTK_DISABLED;
  }
});

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

test("RTK session stats fall back to the managed RTK path when GSD_RTK_PATH is unset", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-rtk-session-managed-"));
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });

  const fake = createFakeRtk({
    "gain --all --format json": { stdout: summary(6, 900, 500, 400) },
  });
  const managedHome = mkdtempSync(join(tmpdir(), "gsd-rtk-home-"));
  const managedDir = join(managedHome, "agent", "bin");
  const managedPath = join(managedDir, process.platform === "win32" ? "rtk.cmd" : "rtk");
  mkdirSync(managedDir, { recursive: true });
  copyFileSync(fake.path, managedPath);
  if (process.platform !== "win32") {
    chmodSync(managedPath, 0o755);
  }

  const previousHome = process.env.GSD_HOME;
  const previousPath = process.env.GSD_RTK_PATH;

  try {
    process.env.GSD_HOME = managedHome;
    delete process.env.GSD_RTK_PATH;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GSD_HOME: managedHome,
    };
    delete env.GSD_RTK_PATH;

    const baseline = ensureRtkSessionBaseline(basePath, "sess-managed", env);
    assert.ok(baseline, "expected baseline from managed RTK path");

    const savings = getRtkSessionSavings(basePath, "sess-managed", env);
    assert.ok(savings, "expected savings snapshot from managed RTK path");
    assert.equal(savings?.commands, 0);
  } finally {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    if (previousPath === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previousPath;
    fake.cleanup();
    rmSync(managedHome, { recursive: true, force: true });
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
  assert.equal(
    formatRtkSavingsLabel({
      commands: 2,
      inputTokens: 0,
      outputTokens: 0,
      savedTokens: 0,
      savingsPct: 0,
      totalTimeMs: 120,
      avgTimeMs: 60,
      updatedAt: new Date().toISOString(),
    }),
    "rtk: active (2 cmds)",
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
