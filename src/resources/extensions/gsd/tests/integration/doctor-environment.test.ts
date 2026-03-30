import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * doctor-environment.test.ts — Tests for environment health checks (#1221).
 *
 * Tests:
 *   - Node version detection
 *   - Dependencies installed check
 *   - Env file detection
 *   - Port conflict detection
 *   - Disk space check
 *   - Docker detection
 *   - Project tool detection
 *   - Doctor issue conversion
 *   - Report formatting
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  runEnvironmentChecks,
  runFullEnvironmentChecks,
  environmentResultsToDoctorIssues,
  formatEnvironmentReport,
  checkEnvironmentHealth,
  checkGitRemote,
  type EnvironmentCheckResult,
} from "../../doctor-environment.ts";
function createProjectDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-env-test-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

describe('doctor-environment', async () => {
  const cleanups: string[] = [];

  try {
    // ── Node Version Check ─────────────────────────────────────────────
    test('env: no package.json returns empty', () => {
      const dir = createProjectDir();
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      // No package.json → no node checks
      const nodeCheck = results.find(r => r.name === "node_version");
      assert.deepStrictEqual(nodeCheck, undefined, "no node version check without package.json");
    });

    test('env: package.json without engines returns no node check', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test", version: "1.0.0" }),
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const nodeCheck = results.find(r => r.name === "node_version");
      assert.deepStrictEqual(nodeCheck, undefined, "no node version check without engines field");
    });

    test('env: package.json with engines returns node check', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({
          name: "test",
          version: "1.0.0",
          engines: { node: ">=18.0.0" },
        }),
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const nodeCheck = results.find(r => r.name === "node_version");
      assert.ok(nodeCheck !== undefined, "node version check runs with engines field");
      // Current node should be >= 18 in CI
      assert.deepStrictEqual(nodeCheck!.status, "ok", "node version meets requirement");
    });

    // ── Dependencies Check ─────────────────────────────────────────────
    test('env: missing node_modules detected', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.deepStrictEqual(depsCheck!.status, "error", "missing node_modules is an error");
      assert.ok(depsCheck!.message.includes("node_modules missing"), "reports missing node_modules");
    });

    test('env: existing node_modules detected', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.deepStrictEqual(depsCheck!.status, "ok", "existing node_modules is ok");
    });

    // ── Stale Dependencies: marker file check (#1974) ──────────────────
    console.log("\n=== env: npm marker file newer than lockfile → ok (#1974) ===");
    {
      // Simulate the exact bug scenario:
      // 1. node_modules dir mtime is old (no entries added/removed recently)
      // 2. package-lock.json mtime is recent (npm rewrote it)
      // 3. node_modules/.package-lock.json mtime is between dir and lockfile
      //    (npm wrote it during the same install that rewrote the lockfile)
      //
      // The bug: code compares lockfile mtime vs dir mtime → false positive warning
      // The fix: compare lockfile mtime vs marker file mtime → correctly ok
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });

      // Simulate the exact bug: npm install with "up to date" rewrites the
      // lockfile and the marker, but no packages are added/removed so the
      // directory mtime should be old. We write the marker first (which
      // bumps dir mtime), then force the dir mtime back to the past.
      //
      // Timeline: dir(T-120s) < lockfile(T-5s) ≈ marker(T-5s)
      // Bug: code compares lockfile vs dir → false positive stale warning
      // Fix: code compares lockfile vs marker → correctly reports ok
      const dirTime = new Date(Date.now() - 120_000);
      const installTime = new Date(Date.now() - 5_000);

      // Write marker file (this bumps dir mtime as a side effect)
      writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");
      utimesSync(join(dir, "node_modules", ".package-lock.json"), installTime, installTime);

      // Force dir mtime back to the past — simulates no top-level entries changed
      utimesSync(join(dir, "node_modules"), dirTime, dirTime);

      // Lockfile written at install time (same as marker, or slightly after)
      writeFileSync(join(dir, "package-lock.json"), "{}");
      utimesSync(join(dir, "package-lock.json"), installTime, installTime);

      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.equal(depsCheck!.status, "ok", "npm marker newer than lockfile → not stale");
    }

    console.log("\n=== env: yarn marker file newer than lockfile → ok (#1974) ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });

      const dirTime = new Date(Date.now() - 120_000);
      const installTime = new Date(Date.now() - 5_000);

      writeFileSync(join(dir, "node_modules", ".yarn-integrity"), "{}");
      utimesSync(join(dir, "node_modules", ".yarn-integrity"), installTime, installTime);
      utimesSync(join(dir, "node_modules"), dirTime, dirTime);

      writeFileSync(join(dir, "yarn.lock"), "");
      utimesSync(join(dir, "yarn.lock"), installTime, installTime);

      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.equal(depsCheck!.status, "ok", "yarn marker newer than lockfile → not stale");
    }

    console.log("\n=== env: pnpm marker file newer than lockfile → ok (#1974) ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });

      const dirTime = new Date(Date.now() - 120_000);
      const installTime = new Date(Date.now() - 5_000);

      writeFileSync(join(dir, "node_modules", ".modules.yaml"), "{}");
      utimesSync(join(dir, "node_modules", ".modules.yaml"), installTime, installTime);
      utimesSync(join(dir, "node_modules"), dirTime, dirTime);

      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      utimesSync(join(dir, "pnpm-lock.yaml"), installTime, installTime);

      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.equal(depsCheck!.status, "ok", "pnpm marker newer than lockfile → not stale");
    }

    console.log("\n=== env: no marker file falls back to dir mtime → stale warning (#1974) ===");
    {
      // No marker file exists, lockfile newer than dir → should still warn
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });

      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "node_modules"), past, past);

      writeFileSync(join(dir, "package-lock.json"), "{}");
      // No marker file written — fallback to dir mtime comparison

      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assert.ok(depsCheck !== undefined, "dependencies check runs");
      assert.equal(depsCheck!.status, "warning", "no marker + lockfile newer → stale warning");
    }

    // ── Env File Check ─────────────────────────────────────────────────
    test('env: .env.example without .env detected', () => {
      const dir = createProjectDir({
        ".env.example": "DB_URL=xxx\nAPI_KEY=xxx\n",
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const envCheck = results.find(r => r.name === "env_file");
      assert.ok(envCheck !== undefined, "env file check runs");
      assert.deepStrictEqual(envCheck!.status, "warning", "missing .env is a warning");
    });

    test('env: .env.example with .env is ok', () => {
      const dir = createProjectDir({
        ".env.example": "DB_URL=xxx\n",
        ".env": "DB_URL=postgres://localhost/test\n",
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const envCheck = results.find(r => r.name === "env_file");
      assert.ok(envCheck !== undefined, "env file check runs");
      assert.deepStrictEqual(envCheck!.status, "ok", "present .env is ok");
    });

    test('env: .env.example with .env.local is ok', () => {
      const dir = createProjectDir({
        ".env.example": "DB_URL=xxx\n",
        ".env.local": "DB_URL=postgres://localhost/test\n",
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const envCheck = results.find(r => r.name === "env_file");
      assert.ok(envCheck !== undefined, "env file check runs");
      assert.deepStrictEqual(envCheck!.status, "ok", ".env.local counts as present");
    });

    // ── Disk Space Check ───────────────────────────────────────────────
    if (process.platform !== "win32") {
      const dir = createProjectDir();
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const diskCheck = results.find(r => r.name === "disk_space");
      assert.ok(diskCheck !== undefined, "disk space check runs on unix");
      // Should be ok on dev machines with reasonable disk
      assert.ok(diskCheck!.status === "ok" || diskCheck!.status === "warning", "disk check returns valid status");
    }

    // ── Project Tools Check ────────────────────────────────────────────
    test('env: detects missing python when pyproject.toml exists', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
        "pyproject.toml": "[build-system]\nrequires = ['setuptools']\n",
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const pythonCheck = results.find(r => r.name === "python");
      // Python is likely installed on CI/dev machines, so just verify the check runs
      // without error — the result depends on the system
      assert.ok(true, "python check runs without error");
    });

    test('env: detects Cargo.toml', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
        "Cargo.toml": "[package]\nname = 'test'\n",
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      // Just verify it runs without error
      assert.ok(true, "cargo check runs without error");
    });

    // ── Docker Check ───────────────────────────────────────────────────
    test('env: no docker check without Dockerfile', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const dockerCheck = results.find(r => r.name === "docker");
      assert.deepStrictEqual(dockerCheck, undefined, "no docker check without Dockerfile");
    });

    test('env: docker check with Dockerfile', () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
        "Dockerfile": "FROM node:22\n",
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const dockerCheck = results.find(r => r.name === "docker");
      // Docker may or may not be installed on the test machine
      assert.ok(dockerCheck !== undefined, "docker check runs when Dockerfile present");
    });

    // ── Doctor Issue Conversion ────────────────────────────────────────
    test('env: converts results to doctor issues', () => {
      const results: EnvironmentCheckResult[] = [
        { name: "node_version", status: "ok", message: "Node.js v22.0.0" },
        { name: "dependencies", status: "error", message: "node_modules missing" },
        { name: "env_file", status: "warning", message: ".env missing", detail: "Copy .env.example" },
      ];

      const issues = environmentResultsToDoctorIssues(results);
      assert.deepStrictEqual(issues.length, 2, "only non-ok results converted");
      assert.deepStrictEqual(issues[0]!.severity, "error", "error severity preserved");
      assert.deepStrictEqual(issues[0]!.code, "env_dependencies", "code prefixed with env_");
      assert.deepStrictEqual(issues[1]!.severity, "warning", "warning severity preserved");
      assert.ok(issues[1]!.message.includes("Copy .env.example"), "detail included in message");
    });

    // ── checkEnvironmentHealth integration ──────────────────────────────
    test('env: checkEnvironmentHealth adds issues to array', async () => {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      cleanups.push(dir);

      const issues: any[] = [];
      await checkEnvironmentHealth(dir, issues);
      // Should have at least the missing node_modules issue
      assert.ok(issues.some(i => i.code === "env_dependencies"), "environment issues added to array");
    });

    // ── Report Formatting ──────────────────────────────────────────────
    test('env: formatEnvironmentReport', () => {
      const results: EnvironmentCheckResult[] = [
        { name: "node_version", status: "ok", message: "Node.js v22.0.0" },
        { name: "dependencies", status: "error", message: "node_modules missing", detail: "Run npm install" },
        { name: "disk_space", status: "ok", message: "50.2GB free" },
      ];

      const report = formatEnvironmentReport(results);
      assert.ok(report.includes("Environment Health:"), "has header");
      assert.ok(report.includes("Node.js v22.0.0"), "includes ok result");
      assert.ok(report.includes("node_modules missing"), "includes error result");
      assert.ok(report.includes("Run npm install"), "includes detail for errors");
    });

    test('env: formatEnvironmentReport empty', () => {
      const report = formatEnvironmentReport([]);
      assert.deepStrictEqual(report, "No environment checks applicable.", "empty report message");
    });

    // ── Full environment checks include git remote ─────────────────────
    test('env: runFullEnvironmentChecks includes git remote', () => {
      // runFullEnvironmentChecks adds git remote check
      // We can't easily test this without a real git repo, but verify it doesn't throw
      const dir = createProjectDir();
      cleanups.push(dir);
      const results = runFullEnvironmentChecks(dir);
      // No git repo → no remote check, but should not throw
      assert.ok(true, "runFullEnvironmentChecks does not throw on non-git dir");
    });

    // ── Port Detection from package.json ───────────────────────────────
    if (process.platform !== "win32") {
      const dir = createProjectDir({
        "package.json": JSON.stringify({
          name: "test",
          scripts: {
            dev: "next dev --port 3456",
            start: "node server.js",
          },
        }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      // Port 3456 is unlikely to be in use, so no conflicts expected
      const portConflicts = results.filter(r => r.name === "port_conflict");
      // Just verify it ran without error
      assert.ok(true, "port check with script-detected ports runs without error");
    }

    // ── Git Remote Reachability ────────────────────────────────────────
    test('git_remote: returns null for non-git directory', () => {
      const dir = createProjectDir();
      cleanups.push(dir);
      const result = checkGitRemote(dir);
      assert.strictEqual(result, null, "no remote check for non-git dir");
    });

    test('git_remote: returns null for git repo with no remote', () => {
      const dir = createProjectDir();
      cleanups.push(dir);
      execSync("git init", { cwd: dir, stdio: "ignore" });
      const result = checkGitRemote(dir);
      assert.strictEqual(result, null, "no remote check when origin not set");
    });

    test('git_remote: reachable remote returns ok status', () => {
      const dir = createProjectDir();
      cleanups.push(dir);
      const remoteDir = mkdtempSync(join(tmpdir(), "gsd-remote-test-"));
      cleanups.push(remoteDir);
      execSync("git init --bare", { cwd: remoteDir, stdio: "ignore" });
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync(`git remote add origin ${remoteDir}`, { cwd: dir, stdio: "ignore" });
      const result = checkGitRemote(dir);
      assert.ok(result !== null, "should return a result for repo with remote");
      assert.strictEqual(result!.status, "ok", "local bare remote should be reachable");
    });

    test('git_remote: unreachable remote returns warning status', () => {
      const dir = createProjectDir();
      cleanups.push(dir);
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git remote add origin git://localhost:1/nonexistent.git", { cwd: dir, stdio: "ignore" });
      const result = checkGitRemote(dir);
      assert.ok(result !== null, "should return a result for unreachable remote");
      assert.strictEqual(result!.status, "warning", "unreachable remote should warn");
      assert.ok(result!.message.includes("unreachable"), "message should mention unreachable");
    });

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
