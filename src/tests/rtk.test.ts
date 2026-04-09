import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildRtkEnv,
  ensureRtkAvailable,
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  GSD_SKIP_RTK_INSTALL_ENV,
  getManagedRtkDir,
  prependPathEntry,
  resolveRtkAssetName,
  resolveRtkBinaryPath,
  rewriteCommandWithRtk,
  validateRtkBinary,
} from "../rtk.ts";
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

test("resolveRtkAssetName maps supported release assets correctly", () => {
  assert.equal(resolveRtkAssetName("darwin", "arm64"), "rtk-aarch64-apple-darwin.tar.gz");
  assert.equal(resolveRtkAssetName("darwin", "x64"), "rtk-x86_64-apple-darwin.tar.gz");
  assert.equal(resolveRtkAssetName("linux", "arm64"), "rtk-aarch64-unknown-linux-gnu.tar.gz");
  assert.equal(resolveRtkAssetName("linux", "x64"), "rtk-x86_64-unknown-linux-musl.tar.gz");
  assert.equal(resolveRtkAssetName("win32", "x64"), "rtk-x86_64-pc-windows-msvc.zip");
  assert.equal(resolveRtkAssetName("win32", "arm64"), null);
});

test("prependPathEntry preserves the original PATH key casing and avoids duplicates", () => {
  const env: NodeJS.ProcessEnv = { Path: "/usr/bin" };
  prependPathEntry(env, "/tmp/gsd-bin");
  assert.equal(env.Path, `/tmp/gsd-bin${delimiter}${"/usr/bin"}`);
  prependPathEntry(env, "/tmp/gsd-bin");
  assert.equal(env.Path, `/tmp/gsd-bin${delimiter}${"/usr/bin"}`);
});

test("buildRtkEnv prepends the managed bin dir and disables telemetry", () => {
  const env = buildRtkEnv({ PATH: "/usr/bin" });
  assert.ok(env.PATH?.startsWith(`${getManagedRtkDir()}${delimiter}`));
  assert.equal(env.RTK_TELEMETRY_DISABLED, "1");
});

test("rewriteCommandWithRtk rewrites when RTK returns exit 0 or 3", () => {
  const spawnSyncImpl = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "rtk git status", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("git status", { binaryPath: "/tmp/rtk", spawnSyncImpl }), "rtk git status");

  const askSpawn = ((_binary: string, _args: string[]) => ({ status: 3, stdout: "rtk npm run test", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("npm run test", { binaryPath: "/tmp/rtk", spawnSyncImpl: askSpawn }), "rtk npm run test");
});

test("rewriteCommandWithRtk passes commands through on no-match or process error", () => {
  const passthroughSpawn = ((_binary: string, _args: string[]) => ({ status: 1, stdout: "", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("echo hello", { binaryPath: "/tmp/rtk", spawnSyncImpl: passthroughSpawn }), "echo hello");

  const failingSpawn = ((_binary: string, _args: string[]) => ({ status: null, stdout: "", error: new Error("boom") })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("git status", { binaryPath: "/tmp/rtk", spawnSyncImpl: failingSpawn }), "git status");
});

test("rewriteCommandWithRtk respects the disable flag", () => {
  const spawnSyncImpl = (() => {
    throw new Error("should not be called");
  }) as unknown as typeof import("node:child_process").spawnSync;

  assert.equal(
    rewriteCommandWithRtk("git status", {
      binaryPath: "/tmp/rtk",
      spawnSyncImpl,
      env: { [GSD_RTK_DISABLED_ENV]: "1" },
    }),
    "git status",
  );
});

test("rewriteCommandWithRtk falls back to the managed RTK path when GSD_RTK_PATH is unset", () => {
  const fake = createFakeRtk({ "git status": "rtk git status" });
  const managedHome = mkdtempSync(join(tmpdir(), "gsd-rtk-managed-home-"));
  const managedDir = join(managedHome, "agent", "bin");
  const managedPath = join(managedDir, process.platform === "win32" ? "rtk.cmd" : "rtk");

  mkdirSync(managedDir, { recursive: true });
  copyFileSync(fake.path, managedPath);
  if (process.platform !== "win32") {
    chmodSync(managedPath, 0o755);
  }

  try {
    const env = {
      ...process.env,
      GSD_HOME: managedHome,
    };
    delete env.GSD_RTK_PATH;

    assert.equal(resolveRtkBinaryPath({ env }), managedPath);
    assert.equal(rewriteCommandWithRtk("git status", { env }), "rtk git status");
  } finally {
    fake.cleanup();
    rmSync(managedHome, { recursive: true, force: true });
  }
});

test("validateRtkBinary checks the rewrite contract", () => {
  const validSpawn = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "rtk git status", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(validateRtkBinary("/tmp/rtk", { spawnSyncImpl: validSpawn }), true);

  const invalidSpawn = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "wrong output", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(validateRtkBinary("/tmp/rtk", { spawnSyncImpl: invalidSpawn }), false);
});

test("ensureRtkAvailable respects explicit disable and skip flags without downloading", async () => {
  const disabled = await ensureRtkAvailable({
    env: { [GSD_RTK_DISABLED_ENV]: "1" },
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.source, "disabled");

  const skipped = await ensureRtkAvailable({
    env: {
      [GSD_SKIP_RTK_INSTALL_ENV]: "1",
      [GSD_RTK_PATH_ENV]: "/tmp/nonexistent-rtk",
    },
  });
  assert.equal(skipped.available, false);
  assert.equal(skipped.source, "missing");
});
