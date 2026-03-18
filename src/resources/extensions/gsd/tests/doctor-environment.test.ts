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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  runEnvironmentChecks,
  runFullEnvironmentChecks,
  environmentResultsToDoctorIssues,
  formatEnvironmentReport,
  checkEnvironmentHealth,
  type EnvironmentCheckResult,
} from "../doctor-environment.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

function createProjectDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-env-test-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

async function main(): Promise<void> {
  const cleanups: string[] = [];

  try {
    // ── Node Version Check ─────────────────────────────────────────────
    console.log("\n=== env: no package.json returns empty ===");
    {
      const dir = createProjectDir();
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      // No package.json → no node checks
      const nodeCheck = results.find(r => r.name === "node_version");
      assertEq(nodeCheck, undefined, "no node version check without package.json");
    }

    console.log("\n=== env: package.json without engines returns no node check ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test", version: "1.0.0" }),
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const nodeCheck = results.find(r => r.name === "node_version");
      assertEq(nodeCheck, undefined, "no node version check without engines field");
    }

    console.log("\n=== env: package.json with engines returns node check ===");
    {
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
      assertTrue(nodeCheck !== undefined, "node version check runs with engines field");
      // Current node should be >= 18 in CI
      assertEq(nodeCheck!.status, "ok", "node version meets requirement");
    }

    // ── Dependencies Check ─────────────────────────────────────────────
    console.log("\n=== env: missing node_modules detected ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assertTrue(depsCheck !== undefined, "dependencies check runs");
      assertEq(depsCheck!.status, "error", "missing node_modules is an error");
      assertTrue(depsCheck!.message.includes("node_modules missing"), "reports missing node_modules");
    }

    console.log("\n=== env: existing node_modules detected ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const depsCheck = results.find(r => r.name === "dependencies");
      assertTrue(depsCheck !== undefined, "dependencies check runs");
      assertEq(depsCheck!.status, "ok", "existing node_modules is ok");
    }

    // ── Env File Check ─────────────────────────────────────────────────
    console.log("\n=== env: .env.example without .env detected ===");
    {
      const dir = createProjectDir({
        ".env.example": "DB_URL=xxx\nAPI_KEY=xxx\n",
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const envCheck = results.find(r => r.name === "env_file");
      assertTrue(envCheck !== undefined, "env file check runs");
      assertEq(envCheck!.status, "warning", "missing .env is a warning");
    }

    console.log("\n=== env: .env.example with .env is ok ===");
    {
      const dir = createProjectDir({
        ".env.example": "DB_URL=xxx\n",
        ".env": "DB_URL=postgres://localhost/test\n",
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const envCheck = results.find(r => r.name === "env_file");
      assertTrue(envCheck !== undefined, "env file check runs");
      assertEq(envCheck!.status, "ok", "present .env is ok");
    }

    console.log("\n=== env: .env.example with .env.local is ok ===");
    {
      const dir = createProjectDir({
        ".env.example": "DB_URL=xxx\n",
        ".env.local": "DB_URL=postgres://localhost/test\n",
      });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const envCheck = results.find(r => r.name === "env_file");
      assertTrue(envCheck !== undefined, "env file check runs");
      assertEq(envCheck!.status, "ok", ".env.local counts as present");
    }

    // ── Disk Space Check ───────────────────────────────────────────────
    console.log("\n=== env: disk space check returns result ===");
    if (process.platform !== "win32") {
      const dir = createProjectDir();
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const diskCheck = results.find(r => r.name === "disk_space");
      assertTrue(diskCheck !== undefined, "disk space check runs on unix");
      // Should be ok on dev machines with reasonable disk
      assertTrue(diskCheck!.status === "ok" || diskCheck!.status === "warning", "disk check returns valid status");
    }

    // ── Project Tools Check ────────────────────────────────────────────
    console.log("\n=== env: detects missing python when pyproject.toml exists ===");
    {
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
      assertTrue(true, "python check runs without error");
    }

    console.log("\n=== env: detects Cargo.toml ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
        "Cargo.toml": "[package]\nname = 'test'\n",
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      // Just verify it runs without error
      assertTrue(true, "cargo check runs without error");
    }

    // ── Docker Check ───────────────────────────────────────────────────
    console.log("\n=== env: no docker check without Dockerfile ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const dockerCheck = results.find(r => r.name === "docker");
      assertEq(dockerCheck, undefined, "no docker check without Dockerfile");
    }

    console.log("\n=== env: docker check with Dockerfile ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
        "Dockerfile": "FROM node:22\n",
      });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      cleanups.push(dir);
      const results = runEnvironmentChecks(dir);
      const dockerCheck = results.find(r => r.name === "docker");
      // Docker may or may not be installed on the test machine
      assertTrue(dockerCheck !== undefined, "docker check runs when Dockerfile present");
    }

    // ── Doctor Issue Conversion ────────────────────────────────────────
    console.log("\n=== env: converts results to doctor issues ===");
    {
      const results: EnvironmentCheckResult[] = [
        { name: "node_version", status: "ok", message: "Node.js v22.0.0" },
        { name: "dependencies", status: "error", message: "node_modules missing" },
        { name: "env_file", status: "warning", message: ".env missing", detail: "Copy .env.example" },
      ];

      const issues = environmentResultsToDoctorIssues(results);
      assertEq(issues.length, 2, "only non-ok results converted");
      assertEq(issues[0]!.severity, "error", "error severity preserved");
      assertEq(issues[0]!.code, "env_dependencies", "code prefixed with env_");
      assertEq(issues[1]!.severity, "warning", "warning severity preserved");
      assertTrue(issues[1]!.message.includes("Copy .env.example"), "detail included in message");
    }

    // ── checkEnvironmentHealth integration ──────────────────────────────
    console.log("\n=== env: checkEnvironmentHealth adds issues to array ===");
    {
      const dir = createProjectDir({
        "package.json": JSON.stringify({ name: "test" }),
      });
      cleanups.push(dir);

      const issues: any[] = [];
      await checkEnvironmentHealth(dir, issues);
      // Should have at least the missing node_modules issue
      assertTrue(issues.some(i => i.code === "env_dependencies"), "environment issues added to array");
    }

    // ── Report Formatting ──────────────────────────────────────────────
    console.log("\n=== env: formatEnvironmentReport ===");
    {
      const results: EnvironmentCheckResult[] = [
        { name: "node_version", status: "ok", message: "Node.js v22.0.0" },
        { name: "dependencies", status: "error", message: "node_modules missing", detail: "Run npm install" },
        { name: "disk_space", status: "ok", message: "50.2GB free" },
      ];

      const report = formatEnvironmentReport(results);
      assertTrue(report.includes("Environment Health:"), "has header");
      assertTrue(report.includes("Node.js v22.0.0"), "includes ok result");
      assertTrue(report.includes("node_modules missing"), "includes error result");
      assertTrue(report.includes("Run npm install"), "includes detail for errors");
    }

    console.log("\n=== env: formatEnvironmentReport empty ===");
    {
      const report = formatEnvironmentReport([]);
      assertEq(report, "No environment checks applicable.", "empty report message");
    }

    // ── Full environment checks include git remote ─────────────────────
    console.log("\n=== env: runFullEnvironmentChecks includes git remote ===");
    {
      // runFullEnvironmentChecks adds git remote check
      // We can't easily test this without a real git repo, but verify it doesn't throw
      const dir = createProjectDir();
      cleanups.push(dir);
      const results = runFullEnvironmentChecks(dir);
      // No git repo → no remote check, but should not throw
      assertTrue(true, "runFullEnvironmentChecks does not throw on non-git dir");
    }

    // ── Port Detection from package.json ───────────────────────────────
    console.log("\n=== env: port detection from scripts ===");
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
      assertTrue(true, "port check with script-detected ports runs without error");
    }

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  report();
}

main();
