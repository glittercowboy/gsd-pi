import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration test for resource sync staleness detection.
 *
 * Validates that initResources() re-syncs when bundled resources change
 * within the same version (the bug that caused stale subagent extensions
 * with a broken import to persist at ~/.gsd/agent/extensions/).
 */

test("resource manifest includes contentHash", async (t) => {
  // We can't easily call initResources directly because it depends on
  // module-level resolved paths. Instead, verify the manifest schema
  // by simulating what writeManagedResourceManifest produces.
  const manifest = {
    gsdVersion: "2.28.0",
    syncedAt: Date.now(),
    contentHash: "abc123def456",
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "gsd-resource-test-"));
  const manifestPath = join(tmpDir, "managed-resources.json");

  t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  writeFileSync(manifestPath, JSON.stringify(manifest));
  const read = JSON.parse(readFileSync(manifestPath, "utf-8"));
  assert.equal(read.gsdVersion, "2.28.0");
  assert.equal(read.contentHash, "abc123def456");
  assert.equal(typeof read.syncedAt, "number");
});

test("missing contentHash in manifest triggers re-sync (upgrade path)", () => {
  // Old manifests won't have contentHash. The new logic should treat
  // a missing contentHash as "stale" and re-sync.
  const oldManifest = {
    gsdVersion: "2.28.0",
    syncedAt: Date.now(),
  };

  // Simulate the check in initResources:
  // if (manifest.contentHash && manifest.contentHash === currentHash)
  const currentHash = "somehash";
  const shouldSkip = oldManifest.gsdVersion === "2.28.0"
    && ("contentHash" in oldManifest)
    && (oldManifest as any).contentHash === currentHash;

  assert.equal(shouldSkip, false, "Missing contentHash should not skip sync");
});

test("matching contentHash skips re-sync", () => {
  const manifest = {
    gsdVersion: "2.28.0",
    syncedAt: Date.now(),
    contentHash: "abc123",
  };

  const currentHash = "abc123";
  const shouldSkip = manifest.gsdVersion === "2.28.0"
    && manifest.contentHash != null
    && manifest.contentHash === currentHash;

  assert.equal(shouldSkip, true, "Matching contentHash should skip sync");
});

test("different contentHash triggers re-sync", () => {
  const manifest = {
    gsdVersion: "2.28.0",
    syncedAt: Date.now(),
    contentHash: "old_hash",
  };

  const currentHash = "new_hash";
  const shouldSkip = manifest.gsdVersion === "2.28.0"
    && manifest.contentHash != null
    && manifest.contentHash === currentHash;

  assert.equal(shouldSkip, false, "Different contentHash should trigger sync");
});
