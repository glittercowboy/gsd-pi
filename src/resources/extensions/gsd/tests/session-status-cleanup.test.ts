/**
 * session-status-cleanup.test.ts — Tests for removeSessionArtifacts.
 *
 * Verifies that all parallel artifacts (status, signal, stdout/stderr logs)
 * are cleaned up when a worker is stopped or a session goes stale.
 * Prevents ghost workers in the monitor overlay from stale log files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  removeSessionArtifacts,
  removeSessionStatus,
} from "../session-status-io.ts";

function makeTempBase(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "session-cleanup-")));
  mkdirSync(join(dir, ".gsd", "parallel"), { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

test("removeSessionArtifacts removes all four artifact types", () => {
  const base = makeTempBase();
  const pDir = join(base, ".gsd", "parallel");
  const mid = "M001";

  // Create all four artifact types
  writeFileSync(join(pDir, `${mid}.status.json`), "{}");
  writeFileSync(join(pDir, `${mid}.signal.json`), "{}");
  writeFileSync(join(pDir, `${mid}.stdout.log`), "output");
  writeFileSync(join(pDir, `${mid}.stderr.log`), "errors");

  // All exist before cleanup
  assert.ok(existsSync(join(pDir, `${mid}.status.json`)));
  assert.ok(existsSync(join(pDir, `${mid}.signal.json`)));
  assert.ok(existsSync(join(pDir, `${mid}.stdout.log`)));
  assert.ok(existsSync(join(pDir, `${mid}.stderr.log`)));

  removeSessionArtifacts(base, mid);

  // All removed after cleanup
  assert.ok(!existsSync(join(pDir, `${mid}.status.json`)), "status.json should be removed");
  assert.ok(!existsSync(join(pDir, `${mid}.signal.json`)), "signal.json should be removed");
  assert.ok(!existsSync(join(pDir, `${mid}.stdout.log`)), "stdout.log should be removed");
  assert.ok(!existsSync(join(pDir, `${mid}.stderr.log`)), "stderr.log should be removed");

  cleanup(base);
});

test("removeSessionArtifacts handles missing files gracefully", () => {
  const base = makeTempBase();
  const pDir = join(base, ".gsd", "parallel");
  const mid = "M002";

  // Only create one file — the rest are missing
  writeFileSync(join(pDir, `${mid}.stderr.log`), "errors");

  // Should not throw
  removeSessionArtifacts(base, mid);

  assert.ok(!existsSync(join(pDir, `${mid}.stderr.log`)), "stderr.log should be removed");

  cleanup(base);
});

test("removeSessionArtifacts does not affect other milestones", () => {
  const base = makeTempBase();
  const pDir = join(base, ".gsd", "parallel");

  // Create artifacts for M001 and M002
  writeFileSync(join(pDir, "M001.stdout.log"), "m001 output");
  writeFileSync(join(pDir, "M001.stderr.log"), "m001 errors");
  writeFileSync(join(pDir, "M002.stdout.log"), "m002 output");
  writeFileSync(join(pDir, "M002.stderr.log"), "m002 errors");

  // Remove only M001
  removeSessionArtifacts(base, "M001");

  assert.ok(!existsSync(join(pDir, "M001.stdout.log")), "M001 stdout should be removed");
  assert.ok(!existsSync(join(pDir, "M001.stderr.log")), "M001 stderr should be removed");
  assert.ok(existsSync(join(pDir, "M002.stdout.log")), "M002 stdout should be untouched");
  assert.ok(existsSync(join(pDir, "M002.stderr.log")), "M002 stderr should be untouched");

  cleanup(base);
});

test("removeSessionStatus only removes status.json, not logs", () => {
  const base = makeTempBase();
  const pDir = join(base, ".gsd", "parallel");
  const mid = "M003";

  writeFileSync(join(pDir, `${mid}.status.json`), "{}");
  writeFileSync(join(pDir, `${mid}.stdout.log`), "output");
  writeFileSync(join(pDir, `${mid}.stderr.log`), "errors");

  removeSessionStatus(base, mid);

  assert.ok(!existsSync(join(pDir, `${mid}.status.json`)), "status.json should be removed");
  assert.ok(existsSync(join(pDir, `${mid}.stdout.log`)), "stdout.log should remain");
  assert.ok(existsSync(join(pDir, `${mid}.stderr.log`)), "stderr.log should remain");

  cleanup(base);
});
