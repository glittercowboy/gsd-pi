/**
 * Unit tests for GSD Directory Validation — safeguards against dangerous directories.
 *
 * Exercises validateDirectory() and assertSafeDirectory() with:
 * - Blocked system paths (/, /usr, /etc, $HOME, C:\Windows)
 * - Temp directory root
 * - Normal project directories (should pass)
 * - Directories with many entries (warning heuristic)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, platform } from "node:os";
import { validateDirectory, assertSafeDirectory } from "../validate-directory.ts";

const isWindows = platform() === "win32";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-validate-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Blocked system paths (Unix) ─────────────────────────────────────────────────

test("validateDirectory: root filesystem is blocked", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("system directory"));
});

test("validateDirectory: /usr is blocked", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/usr");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

test("validateDirectory: /etc is blocked", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/etc");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

test("validateDirectory: /var is blocked", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/var");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

test("validateDirectory: /usr/local/bin is blocked", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/usr/local/bin");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

// ─── Blocked system paths (Windows) ──────────────────────────────────────────────

test("validateDirectory: C:\\ is blocked", { skip: !isWindows ? "Windows-only test" : undefined }, () => {
  const result = validateDirectory("C:\\");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("system directory"));
});

test("validateDirectory: C:\\Windows is blocked", { skip: !isWindows ? "Windows-only test" : undefined }, () => {
  const result = validateDirectory("C:\\Windows");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

test("validateDirectory: D:\\Windows is blocked", { skip: !isWindows ? "Windows-only test" : undefined }, () => {
  const result = validateDirectory("D:\\Windows");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("system directory"));
});

test("validateDirectory: E:\\Program Files is blocked", { skip: !isWindows ? "Windows-only test" : undefined }, () => {
  const result = validateDirectory("E:\\Program Files");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("system directory"));
});

test("validateDirectory: any Windows drive root is blocked", { skip: !isWindows ? "Windows-only test" : undefined }, () => {
  const result = validateDirectory("D:\\");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("system directory"));
});

// ─── Home directory (cross-platform) ─────────────────────────────────────────────

test("validateDirectory: home directory itself is blocked", () => {
  const result = validateDirectory(homedir());
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("home directory"));
});

test("validateDirectory: home directory with trailing slash is blocked", () => {
  const sep = isWindows ? "\\" : "/";
  const result = validateDirectory(homedir() + sep);
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

test("validateDirectory: subdirectory of home is NOT blocked", () => {
  const dir = makeTempDir("home-subdir");
  try {
    const result = validateDirectory(dir);
    assert.equal(result.severity, "ok");
    assert.equal(result.safe, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression test for #1317: GSD worktree inside $HOME must not be blocked even
// when the resolved project root equals $HOME (e.g. home dir is a git repo).
test("validateDirectory: GSD worktree path nested under home is NOT blocked (#1317)", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const fakeHome = makeTempDir("fake-home");
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  const worktreePath = join(homedir(), ".gsd", "worktrees", "M001");
  const worktreeRoot = join(fakeHome, ".gsd", "worktrees", "M001");
  mkdirSync(worktreePath, { recursive: true });
  try {
    // The worktree CWD itself is a valid location — it must pass.
    const result = validateDirectory(worktreePath);
    assert.equal(result.safe, true, "GSD worktree path should be safe to run in");
    assert.equal(result.severity, "ok");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ─── Temp directory root ─────────────────────────────────────────────────────────

test("validateDirectory: temp directory root is blocked", () => {
  const result = validateDirectory(tmpdir());
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
  assert.ok(result.reason?.includes("temp directory"));
});

// ─── Normal project directories ──────────────────────────────────────────────────

test("validateDirectory: normal project directory is safe", () => {
  const dir = makeTempDir("normal-project");
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "src"));
    const result = validateDirectory(dir);
    assert.equal(result.safe, true);
    assert.equal(result.severity, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateDirectory: empty directory is safe", () => {
  const dir = makeTempDir("empty");
  try {
    const result = validateDirectory(dir);
    assert.equal(result.safe, true);
    assert.equal(result.severity, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── High entry count heuristic ──────────────────────────────────────────────────

test("validateDirectory: directory with >200 entries triggers warning", () => {
  const dir = makeTempDir("many-entries");
  try {
    for (let i = 0; i < 210; i++) {
      writeFileSync(join(dir, `file-${i.toString().padStart(4, "0")}.txt`), "");
    }
    const result = validateDirectory(dir);
    assert.equal(result.safe, false);
    assert.equal(result.severity, "warning");
    assert.ok(result.reason?.includes("210 entries"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateDirectory: directory with exactly 200 entries is safe", () => {
  const dir = makeTempDir("boundary-entries");
  try {
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(dir, `file-${i.toString().padStart(4, "0")}.txt`), "");
    }
    const result = validateDirectory(dir);
    assert.equal(result.safe, true);
    assert.equal(result.severity, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── assertSafeDirectory ─────────────────────────────────────────────────────────

test("assertSafeDirectory: throws for blocked directories", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  assert.throws(
    () => assertSafeDirectory("/"),
    (err: Error) => err.message.includes("system directory"),
  );
});

test("assertSafeDirectory: throws for home directory", () => {
  assert.throws(
    () => assertSafeDirectory(homedir()),
    (err: Error) => err.message.includes("home directory"),
  );
});

test("assertSafeDirectory: returns result for warnings (does not throw)", () => {
  const dir = makeTempDir("assert-warning");
  try {
    for (let i = 0; i < 210; i++) {
      writeFileSync(join(dir, `file-${i.toString().padStart(4, "0")}.txt`), "");
    }
    const result = assertSafeDirectory(dir);
    assert.equal(result.severity, "warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertSafeDirectory: returns ok for safe directories", () => {
  const dir = makeTempDir("assert-safe");
  try {
    const result = assertSafeDirectory(dir);
    assert.equal(result.severity, "ok");
    assert.equal(result.safe, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Trailing slash normalization ────────────────────────────────────────────────

test("validateDirectory: handles paths with trailing slashes", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/usr/");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});

test("validateDirectory: handles paths with multiple trailing slashes", { skip: isWindows ? "Unix-only test" : undefined }, () => {
  const result = validateDirectory("/etc///");
  assert.equal(result.safe, false);
  assert.equal(result.severity, "blocked");
});
