import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression test for gsd-build/gsd-2 #4787.
 *
 * Background: `computeResourceFingerprint` previously hashed the relative
 * file path + file size only. Same-byte-length edits to bundled prompt
 * templates (e.g. the #4570 retry-cap fix to parallel-research-slices.md)
 * slipped through the fingerprint gate in `initResources`, so existing
 * installs silently kept serving the stale cached copy from
 * `~/.gsd/agent/extensions/gsd/prompts/`.
 *
 * The fix hashes file CONTENTS (sha256) instead of just size — any edit,
 * regardless of length, produces a different fingerprint and triggers a
 * resync on next launch.
 */

test("computeResourceFingerprint detects same-size content edits (#4787)", async (t) => {
  const { computeResourceFingerprint } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-fingerprint-content-"));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  const dirA = join(tmp, "bundled-a");
  const dirB = join(tmp, "bundled-b");
  mkdirSync(join(dirA, "prompts"), { recursive: true });
  mkdirSync(join(dirB, "prompts"), { recursive: true });

  // Same byte length (32 bytes each), different content — mirrors the
  // real-world #4787 scenario where a hotfix edit keeps the file size
  // stable but changes load-bearing instructions.
  const contentA = "retry subagent once then BLOCKER"; // 32 bytes
  const contentB = "retry subagent forever never stp"; // 32 bytes
  assert.equal(Buffer.byteLength(contentA), Buffer.byteLength(contentB));

  writeFileSync(join(dirA, "prompts", "foo.md"), contentA);
  writeFileSync(join(dirB, "prompts", "foo.md"), contentB);

  const hashA = computeResourceFingerprint(dirA);
  const hashB = computeResourceFingerprint(dirB);

  assert.notEqual(
    hashA,
    hashB,
    "same-size, different-content trees must yield different fingerprints",
  );
});

test("syncResourceDir overwrites same-size stale content on refresh (#4787)", async (t) => {
  const { syncResourceDir } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-sync-samesize-"));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  const bundled = join(tmp, "bundled", "prompts");
  const installed = join(tmp, "installed", "prompts");
  mkdirSync(bundled, { recursive: true });
  mkdirSync(installed, { recursive: true });

  // Bundled (new): the post-#4570 fix template
  const newContent = "retry subagent once then BLOCKER";
  // Installed (stale): pre-#4570 template with the same byte length
  const staleContent = "retry subagent forever never stp";
  assert.equal(Buffer.byteLength(newContent), Buffer.byteLength(staleContent));

  writeFileSync(join(bundled, "parallel-research-slices.md"), newContent);
  writeFileSync(join(installed, "parallel-research-slices.md"), staleContent);

  // syncResourceDir always force-copies; this guards that the copy path
  // itself overwrites regardless of size.
  syncResourceDir(join(tmp, "bundled"), join(tmp, "installed"));

  const actual = readFileSync(join(installed, "parallel-research-slices.md"), "utf-8");
  assert.equal(
    actual,
    newContent,
    "installed prompt must be overwritten with bundled content even when sizes match",
  );
});
