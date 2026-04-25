/**
 * clean-root-preflight.test.ts — Regression tests for #2909.
 *
 * Tests that preflightCleanRoot warns + stashes on dirty trees,
 * is a no-op on clean trees, and that postflightPopStash restores
 * stashed changes after a merge.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { preflightCleanRoot, postflightPopStash } from "../clean-root-preflight.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-preflight-test-")));
  run("git init", dir);
  run("git config user.email test@example.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

// ── Clean tree: fast-path returns immediately without stashing ─────────────

test("preflightCleanRoot — clean tree returns stashPushed=false and emits no notifications", () => {
  const repo = createTempRepo();
  try {
    const notifications: Array<{ msg: string; level: string }> = [];
    const result = preflightCleanRoot(repo, "M001", (msg, level) => {
      notifications.push({ msg, level });
    });

    assert.equal(result.stashPushed, false, "stashPushed must be false for clean tree");
    assert.equal(result.summary, "", "summary must be empty for clean tree");
    assert.equal(notifications.length, 0, "no notifications on clean tree");

    // Verify no stash was created
    const stashList = run("git stash list", repo);
    assert.equal(stashList, "", "no stash entry on clean tree");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
  }
});

// ── Dirty tree: warns, stashes, returns stashPushed=true ──────────────────

test("preflightCleanRoot — dirty tree warns user and auto-stashes", () => {
  const repo = createTempRepo();
  try {
    // Dirty an existing tracked file
    writeFileSync(join(repo, "README.md"), "# locally modified\n");

    const notifications: Array<{ msg: string; level: string }> = [];
    const result = preflightCleanRoot(repo, "M002", (msg, level) => {
      notifications.push({ msg, level });
    });

    assert.equal(result.stashPushed, true, "stashPushed must be true when tree was dirty");
    assert.ok(result.summary.length > 0, "summary must be non-empty when stash was pushed");

    // A warning notification must have been emitted before stashing
    assert.ok(
      notifications.some(n => n.level === "warning" && n.msg.includes("M002")),
      "warning notification must mention the milestone ID",
    );

    // Working tree must now be clean (stash pushed)
    const status = run("git status --porcelain", repo);
    assert.equal(status, "", "working tree must be clean after stash push");

    // The stash entry must exist
    const stashList = run("git stash list", repo);
    assert.ok(stashList.includes("gsd-preflight-stash"), "stash entry must be named gsd-preflight-stash");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
  }
});

// ── Untracked files are also stashed ─────────────────────────────────────

test("preflightCleanRoot — untracked file triggers stash with --include-untracked", () => {
  const repo = createTempRepo();
  try {
    // Add an untracked file
    writeFileSync(join(repo, "untracked.ts"), "export const x = 1;\n");

    const notifications: Array<{ msg: string; level: string }> = [];
    const result = preflightCleanRoot(repo, "M003", (msg, level) => {
      notifications.push({ msg, level });
    });

    assert.equal(result.stashPushed, true, "stashPushed must be true for untracked file");

    const status = run("git status --porcelain", repo);
    assert.equal(status, "", "working tree must be clean after stash push");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
  }
});

// ── postflightPopStash: restores stashed changes ──────────────────────────

test("postflightPopStash — restores stashed changes and emits info notification", () => {
  const repo = createTempRepo();
  try {
    // Dirty the working tree
    writeFileSync(join(repo, "README.md"), "# stash me\n");

    const preNotifications: Array<{ msg: string; level: string }> = [];
    const preflight = preflightCleanRoot(repo, "M004", (msg, level) => {
      preNotifications.push({ msg, level });
    });
    assert.equal(preflight.stashPushed, true, "preflight must have stashed");

    // Simulate the merge (just a no-op commit here)
    writeFileSync(join(repo, "merged.ts"), "export const merged = true;\n");
    run("git add .", repo);
    run('git commit -m "simulate merge"', repo);

    const postNotifications: Array<{ msg: string; level: string }> = [];
    postflightPopStash(repo, "M004", (msg, level) => {
      postNotifications.push({ msg, level });
    });

    // The stashed README.md change must be restored
    const content = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "# stash me\n", "stashed file must be restored");

    // An info notification must have been emitted
    assert.ok(
      postNotifications.some(n => n.level === "info" && n.msg.includes("M004")),
      "info notification must mention milestone ID after pop",
    );

    // Stash list must be empty
    const stashList = run("git stash list", repo);
    assert.equal(stashList, "", "stash list must be empty after pop");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
  }
});

// ── Round-trip: preflight + merge + postflight preserves changes ──────────

test("preflight + merge + postflight round-trip preserves uncommitted changes", () => {
  const repo = createTempRepo();
  try {
    const originalContent = "# my local work\n";
    writeFileSync(join(repo, "README.md"), originalContent);

    // Preflight: stash
    const preflight = preflightCleanRoot(repo, "M005", () => {});
    assert.equal(preflight.stashPushed, true, "must have stashed");

    // Merge: introduce a new file (no overlap with README.md)
    writeFileSync(join(repo, "feature.ts"), "export const feature = true;\n");
    run("git add feature.ts", repo);
    run('git commit -m "feat: add feature"', repo);

    // Postflight: pop stash
    postflightPopStash(repo, "M005", () => {});

    // README.md must still have our local content
    const restored = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(restored.replace(/\r\n/g, "\n"), originalContent, "local changes must survive merge");

    // feature.ts must also exist (the merge commit landed)
    const featureContent = readFileSync(join(repo, "feature.ts"), "utf-8");
    assert.ok(featureContent.includes("feature"), "merged feature must be present");
  } finally {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
  }
});
