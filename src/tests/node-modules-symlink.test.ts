import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("initResources creates node_modules symlink in agent dir", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-symlink-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    initResources(fakeAgentDir);

    const nodeModulesPath = join(fakeAgentDir, "node_modules");
    // Use lstatSync instead of existsSync — existsSync follows the symlink and
    // returns false for dangling symlinks (e.g. in worktrees without node_modules)
    let stat;
    try {
      stat = lstatSync(nodeModulesPath);
    } catch {
      assert.fail("node_modules symlink should exist after initResources");
    }
    assert.equal(stat.isSymbolicLink(), true, "node_modules should be a symlink, not a real directory");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("initResources replaces a real directory blocking node_modules with a symlink", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-symlink-realdir-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    // First call to set up agent dir structure
    initResources(fakeAgentDir);

    const nodeModulesPath = join(fakeAgentDir, "node_modules");

    // Remove the symlink and replace with a real directory
    rmSync(nodeModulesPath, { recursive: true, force: true });
    mkdirSync(nodeModulesPath, { recursive: true });

    const statBefore = lstatSync(nodeModulesPath);
    assert.equal(statBefore.isSymbolicLink(), false, "should be a real directory before fix");
    assert.equal(statBefore.isDirectory(), true, "should be a real directory before fix");

    // Second call should replace the real directory with a symlink
    initResources(fakeAgentDir);

    const statAfter = lstatSync(nodeModulesPath);
    assert.equal(statAfter.isSymbolicLink(), true, "real directory should be replaced with symlink");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("initResources replaces a stale symlink with a correct one", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-symlink-stale-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    // First call to set up agent dir structure
    initResources(fakeAgentDir);

    const nodeModulesPath = join(fakeAgentDir, "node_modules");
    const correctTarget = readlinkSync(nodeModulesPath);

    // Remove and replace with a stale symlink pointing to a non-existent path
    unlinkSync(nodeModulesPath);
    symlinkSync("/tmp/nonexistent-gsd-node-modules-" + Date.now(), nodeModulesPath);

    const staleTarget = readlinkSync(nodeModulesPath);
    assert.notEqual(staleTarget, correctTarget, "stale symlink should point elsewhere");

    // Second call should fix the stale symlink
    initResources(fakeAgentDir);

    const fixedTarget = readlinkSync(nodeModulesPath);
    assert.equal(fixedTarget, correctTarget, "stale symlink should be replaced with correct target");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("initResources replaces symlink whose target was deleted", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-symlink-missing-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    initResources(fakeAgentDir);

    const nodeModulesPath = join(fakeAgentDir, "node_modules");
    const correctTarget = readlinkSync(nodeModulesPath);

    // Create a symlink that points to a path that doesn't exist
    // (simulates the case where npm upgrade moved the package location)
    unlinkSync(nodeModulesPath);
    const deadTarget = join(tmp, "old-install", "node_modules");
    symlinkSync(deadTarget, nodeModulesPath);

    // The symlink itself exists but its target doesn't
    assert.equal(lstatSync(nodeModulesPath).isSymbolicLink(), true);
    assert.equal(existsSync(deadTarget), false, "dead target should not exist");

    initResources(fakeAgentDir);

    const fixedTarget = readlinkSync(nodeModulesPath);
    assert.equal(fixedTarget, correctTarget, "broken symlink should be replaced with correct target");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
