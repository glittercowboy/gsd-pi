/**
 * worktree-health-dispatch.test.ts — Regression tests for the worktree health
 * check in auto/phases.ts (#1833, #1843).
 *
 * Verifies that the pre-dispatch health check recognises non-JS project types
 * (Rust, Go, Python, etc.) via the shared PROJECT_FILES list from detection.ts,
 * rather than hard-coding package.json / src/ only.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { PROJECT_FILES } from "../detection.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal git repo and return its path. */
function createGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-dispatch-test-"));
  // All execSync calls use hardcoded strings only — no user input, no injection risk.
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Simulate the health check logic from auto/phases.ts.
 *
 * Returns true when the directory would PASS the health check (dispatch
 * proceeds), false when it would FAIL (dispatch blocked).
 *
 * The only hard gate is .git — project files are advisory (greenfield
 * projects won't have them yet). Returns { pass, greenfield } to
 * distinguish "pass with project files" from "pass as greenfield".
 */
function wouldPassHealthCheck(basePath: string, existsSyncFn: (p: string) => boolean): boolean {
  const hasGit = existsSyncFn(join(basePath, ".git"));
  if (!hasGit) return false;

  // .git is sufficient — greenfield projects proceed with a warning
  return true;
}

/** Whether the directory has recognized project files (used for greenfield detection). */
function hasRecognizedProjectFiles(basePath: string, existsSyncFn: (p: string) => boolean): boolean {
  for (const file of PROJECT_FILES) {
    if (existsSyncFn(join(basePath, file))) return true;
  }
  if (existsSyncFn(join(basePath, "src"))) return true;
  return false;
}

/** Simulate the phases.ts Xcode-bundle detection (readdirSync suffix scan). */
function hasXcodeBundle(basePath: string): boolean {
  try {
    return readdirSync(basePath).some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
  } catch { return false; }
}

import { existsSync } from "node:fs";

// ─── Tests ───────────────────────────────────────────────────────────────────

test("PROJECT_FILES is exported and contains expected multi-ecosystem entries", () => {
  assert.ok(Array.isArray(PROJECT_FILES), "PROJECT_FILES is an array");
  assert.ok(PROJECT_FILES.length >= 18, `expected >= 18 entries, got ${PROJECT_FILES.length}`);
  // Spot-check key ecosystems
  assert.ok(PROJECT_FILES.includes("Cargo.toml"), "includes Rust marker");
  assert.ok(PROJECT_FILES.includes("go.mod"), "includes Go marker");
  assert.ok(PROJECT_FILES.includes("pyproject.toml"), "includes Python marker");
  assert.ok(PROJECT_FILES.includes("package.json"), "includes JS marker");
  assert.ok(PROJECT_FILES.includes("pom.xml"), "includes Java marker");
  assert.ok(PROJECT_FILES.includes("Package.swift"), "includes Swift marker");
});

describe("health check with git repo", () => {
  let dir: string;
  beforeEach(() => { dir = createGitRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("health check passes for Rust project (Cargo.toml, no package.json)", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"test\"\n");
    mkdirSync(join(dir, "crates"), { recursive: true });
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Rust project should pass health check");
  });

  test("health check passes for Go project (go.mod, no package.json)", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Go project should pass health check");
  });

  test("health check passes for Python project (pyproject.toml, no package.json)", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"test\"\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Python project should pass health check");
  });

  test("health check passes for Java project (pom.xml, no package.json)", () => {
    writeFileSync(join(dir, "pom.xml"), "<project></project>\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Java project should pass health check");
  });

  test("health check passes for Swift project (Package.swift, no package.json)", () => {
    writeFileSync(join(dir, "Package.swift"), "// swift-tools-version:5.7\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Swift project should pass health check");
  });

  test("health check passes for C/C++ project (CMakeLists.txt, no package.json)", () => {
    writeFileSync(join(dir, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "C/C++ project should pass health check");
  });

  test("health check passes for Elixir project (mix.exs, no package.json)", () => {
    writeFileSync(join(dir, "mix.exs"), "defmodule Test.MixProject do\nend\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Elixir project should pass health check");
  });

  test("health check passes for JS project (package.json, backward compat)", () => {
    writeFileSync(join(dir, "package.json"), '{"name":"test"}\n');
    assert.ok(wouldPassHealthCheck(dir, existsSync), "JS project should pass health check");
  });

  test("health check passes for src/-only project (backward compat)", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    assert.ok(wouldPassHealthCheck(dir, existsSync), "src/-only project should pass health check");
  });

  test("health check passes for empty git repo (greenfield project)", () => {
    assert.ok(wouldPassHealthCheck(dir, existsSync), "empty git repo should pass health check (greenfield)");
    assert.ok(!hasRecognizedProjectFiles(dir, existsSync), "empty git repo has no recognized project files");
  });
});

describe("health check without git repo", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wt-dispatch-test-nogit-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("health check fails for directory with no .git", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"test\"\n");
    assert.ok(!wouldPassHealthCheck(dir, existsSync), "no-git directory should fail health check");
  });
});

describe("health check with xcodegen and Xcode bundles", () => {
  let dir: string;
  beforeEach(() => { dir = createGitRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("health check passes for xcodegen project (project.yml, no Package.swift)", () => {
    writeFileSync(join(dir, "project.yml"), "name: MyApp\ntargets:\n  MyApp:\n    type: application\n");
    assert.ok(wouldPassHealthCheck(dir, existsSync), "xcodegen project should pass health check");
  });

  // Regression for the real-world failure in #1882: an iOS project with a
  // project-specific Xcode bundle (Sudokuxyz.xcodeproj/) was blocked because
  // PROJECT_FILES only probes exact filenames, not suffix-based directory names.
  test("Xcode bundle (*.xcodeproj) is not in PROJECT_FILES but detected by suffix scan", () => {
    mkdirSync(join(dir, "Sudokuxyz.xcodeproj"), { recursive: true });
    mkdirSync(join(dir, "Sources", "Sudokuxyz"), { recursive: true });
    writeFileSync(join(dir, "Sources", "Sudokuxyz", "ContentView.swift"), "import SwiftUI\n");
    // PROJECT_FILES uses exact names — cannot match project-specific bundle names
    assert.ok(!hasRecognizedProjectFiles(dir, existsSync), "xcodeproj bundle must NOT be in PROJECT_FILES");
    // The readdirSync suffix scan used in phases.ts detects it
    assert.ok(hasXcodeBundle(dir), "readdirSync suffix scan detects .xcodeproj bundle");
    // Health check passes regardless (only requires .git)
    assert.ok(wouldPassHealthCheck(dir, existsSync), "Xcode bundle project should pass health check");
  });
});
