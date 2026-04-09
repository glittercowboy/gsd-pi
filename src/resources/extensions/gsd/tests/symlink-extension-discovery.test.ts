// Regression test for: discoverManifests() skips symlinked extension directories
//
// The bug: Dirent.isDirectory() returns false for symlinks, so extensions installed
// as directory symlinks under ~/.gsd/agent/extensions/ were invisible to all
// management commands (list, enable, disable, info).
//
// The fix: check `entry.isDirectory() || entry.isSymbolicLink()`, matching the
// pattern already used in loader.ts discoverExtensionsInDir().

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Inline the discovery logic so the test is self-contained and can verify both
// the buggy and fixed behaviour without importing the private function.
function discoverManifestsBuggy(extDir: string): string[] {
  const found: string[] = [];
  if (!existsSync(extDir)) return found;
  for (const entry of readdirSync(extDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // BUG: skips symlinks
    const mPath = join(extDir, entry.name, "extension-manifest.json");
    if (existsSync(mPath)) found.push(entry.name);
  }
  return found;
}

function discoverManifestsFixed(extDir: string): string[] {
  const found: string[] = [];
  if (!existsSync(extDir)) return found;
  for (const entry of readdirSync(extDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue; // FIX
    const mPath = join(extDir, entry.name, "extension-manifest.json");
    if (existsSync(mPath)) found.push(entry.name);
  }
  return found;
}

const MANIFEST = JSON.stringify({
  id: "test-ext",
  name: "Test Extension",
  version: "1.0.0",
  description: "A test extension",
  tier: "community",
  requires: { platform: "linux" },
});

describe("symlink extension discovery", () => {
  let tmp: string;
  let extDir: string;
  let realExtDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-ext-test-"));
    extDir = join(tmp, "agent", "extensions");
    realExtDir = join(tmp, "my-ext-source");

    // Create the real extension directory outside extDir (simulates a dev checkout)
    mkdirSync(realExtDir, { recursive: true });
    writeFileSync(join(realExtDir, "extension-manifest.json"), MANIFEST, "utf-8");

    // Create the extensions scan directory
    mkdirSync(extDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("real directory is discovered by both implementations", () => {
    // Install extension as a real directory copy
    const realCopy = join(extDir, "my-ext");
    mkdirSync(realCopy);
    writeFileSync(join(realCopy, "extension-manifest.json"), MANIFEST, "utf-8");

    assert.deepEqual(discoverManifestsBuggy(extDir), ["my-ext"]);
    assert.deepEqual(discoverManifestsFixed(extDir), ["my-ext"]);
  });

  test("symlinked directory is missed by buggy implementation", () => {
    // Install extension as a directory symlink — the common dev workflow
    symlinkSync(realExtDir, join(extDir, "my-ext"));

    // Buggy: symlink is invisible
    assert.deepEqual(discoverManifestsBuggy(extDir), []);
  });

  test("symlinked directory is discovered by fixed implementation", () => {
    symlinkSync(realExtDir, join(extDir, "my-ext"));

    // Fixed: symlink is visible
    assert.deepEqual(discoverManifestsFixed(extDir), ["my-ext"]);
  });

  test("non-manifest symlinks are ignored", () => {
    // Symlink to a dir that has no manifest — should not appear
    const noManifestDir = join(tmp, "no-manifest");
    mkdirSync(noManifestDir);
    symlinkSync(noManifestDir, join(extDir, "no-manifest"));

    assert.deepEqual(discoverManifestsFixed(extDir), []);
  });

  test("mix of real dirs and symlinks are all discovered", () => {
    // Real dir
    const realCopy = join(extDir, "ext-real");
    mkdirSync(realCopy);
    writeFileSync(join(realCopy, "extension-manifest.json"), MANIFEST, "utf-8");

    // Symlink dir
    symlinkSync(realExtDir, join(extDir, "ext-symlink"));

    const found = discoverManifestsFixed(extDir).sort();
    assert.deepEqual(found, ["ext-real", "ext-symlink"]);
  });
});
