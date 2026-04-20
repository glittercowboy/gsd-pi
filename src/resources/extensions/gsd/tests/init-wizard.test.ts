/**
 * Unit tests for GSD Init Wizard — project onboarding flow.
 *
 * Tests the bootstrap logic and preferences file generation
 * without requiring interactive UI (tests the pure functions).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the detection module integration since the wizard's UI
// requires interactive ctx/pi which can't be unit-tested directly.
// The bootstrap and preferences generation are tested via detection + filesystem checks.

import { detectProjectState } from "../detection.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-init-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ─── Detection Integration Tests ────────────────────────────────────────────────

test("init-wizard: clean folder detected as state=none", (t) => {
  const dir = makeTempDir("clean");
  t.after(() => { cleanup(dir); });

  const detection = detectProjectState(dir);
  assert.equal(detection.state, "none");
  assert.equal(detection.v1, undefined);
  assert.equal(detection.v2, undefined);
});

test("init-wizard: v1 .planning/ triggers v1-planning state", (t) => {
  const dir = makeTempDir("v1");
  try {
    mkdirSync(join(dir, ".planning", "phases", "01"), { recursive: true });
    mkdirSync(join(dir, ".planning", "phases", "02"), { recursive: true });
    writeFileSync(join(dir, ".planning", "ROADMAP.md"), "# v1 roadmap\n", "utf-8");

    const detection = detectProjectState(dir);
    assert.equal(detection.state, "v1-planning");
    assert.ok(detection.v1);
    assert.equal(detection.v1!.phaseCount, 2);
    assert.equal(detection.v1!.hasRoadmap, true);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: existing .gsd/ with milestones skips init", (t) => {
  const dir = makeTempDir("existing");
  try {
    mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
    mkdirSync(join(dir, ".gsd", "milestones", "M002"), { recursive: true });

    const detection = detectProjectState(dir);
    assert.equal(detection.state, "v2-gsd");
    assert.ok(detection.v2);
    assert.equal(detection.v2!.milestoneCount, 2);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: empty .gsd/ (no milestones) returns v2-gsd-empty", (t) => {
  const dir = makeTempDir("empty-gsd");
  try {
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });

    const detection = detectProjectState(dir);
    assert.equal(detection.state, "v2-gsd-empty");
    assert.ok(detection.v2);
    assert.equal(detection.v2!.milestoneCount, 0);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: project signals populate from Node.js project", (t) => {
  const dir = makeTempDir("node-project");
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "my-app",
        scripts: { test: "vitest", build: "tsc", lint: "eslint ." },
      }),
      "utf-8",
    );
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "__tests__"), { recursive: true });

    const detection = detectProjectState(dir);
    const signals = detection.projectSignals;
    assert.equal(signals.primaryLanguage, "javascript/typescript");
    assert.equal(signals.isGitRepo, true);
    assert.equal(signals.hasCI, true);
    assert.equal(signals.hasTests, true);
    assert.ok(signals.verificationCommands.length > 0);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: v2 .gsd/ preferences detected", (t) => {
  const dir = makeTempDir("prefs-detect");
  try {
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\nversion: 1\nmode: solo\n---\n", "utf-8");

    const detection = detectProjectState(dir);
    assert.ok(detection.v2);
    assert.equal(detection.v2!.hasPreferences, true);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: v2 uppercase PREFERENCES.md also detected", (t) => {
  const dir = makeTempDir("prefs-upper");
  try {
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\nversion: 1\n---\n", "utf-8");

    const detection = detectProjectState(dir);
    assert.ok(detection.v2);
    assert.equal(detection.v2!.hasPreferences, true);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: CONTEXT.md detected in v2", (t) => {
  const dir = makeTempDir("context");
  try {
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "CONTEXT.md"), "# Project Context\n", "utf-8");

    const detection = detectProjectState(dir);
    assert.ok(detection.v2);
    assert.equal(detection.v2!.hasContext, true);
  } finally {
    cleanup(dir);
  }
});

test("init-wizard: multiple project files detected together", (t) => {
  const dir = makeTempDir("multi-files");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    writeFileSync(join(dir, "Makefile"), "build:\n\techo ok\n", "utf-8");
    mkdirSync(join(dir, ".git"), { recursive: true });

    const detection = detectProjectState(dir);
    const signals = detection.projectSignals;
    assert.ok(signals.detectedFiles.includes("package.json"));
    assert.ok(signals.detectedFiles.includes("Makefile"));
    assert.equal(signals.isGitRepo, true);
  } finally {
    cleanup(dir);
  }
});

// ─── Git init + initial commit regression (#4530) ───────────────────────────

import { execFileSync } from "node:child_process";
import { nativeInit, nativeAddAll, nativeCommit } from "../native-git-bridge.ts";

test("init-wizard: nativeInit + nativeAddAll + nativeCommit produces a reachable HEAD (#4530)", (t) => {
  // Regression: showProjectInit called nativeInit but never committed, leaving
  // the branch unborn. git log and git worktree add both fail on zero-commit repos.
  const dir = makeTempDir("git-init-commit");
  t.after(() => { cleanup(dir); });

  nativeInit(dir, "main");
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), "*.log\n", "utf-8");

  nativeAddAll(dir);
  nativeCommit(dir, "chore: init project");

  // git log must succeed (was: fatal: your current branch 'main' does not have any commits yet)
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
  assert.equal(subject, "chore: init project");
});

test("init-wizard: v1 with both .planning/ and .gsd/ prioritizes v2", (t) => {
  const dir = makeTempDir("both-v1-v2");
  try {
    mkdirSync(join(dir, ".planning", "phases"), { recursive: true });
    mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });

    const detection = detectProjectState(dir);
    // v2 should take priority
    assert.equal(detection.state, "v2-gsd");
    // But v1 info should still be available for migration reference
    assert.ok(detection.v1);
  } finally {
    cleanup(dir);
  }
});
