/**
 * Unit tests for the verification gate — command discovery and execution.
 *
 * Tests cover:
 *   1. Discovery from explicit preference commands
 *   2. Discovery from task plan verify field
 *   3. Discovery from package.json typecheck/lint/test scripts
 *   4. First-non-empty-wins precedence
 *   5. All commands pass → gate passes
 *   6. One command fails → gate fails with exit code + stderr
 *   7. Missing package.json → 0 checks → pass
 *   8. Empty scripts → 0 checks → pass
 *   9. Preference validation for verification keys
 *  10. spawnSync error (command not found) → failure with exit code 127
 *  11. Dependency audit — git diff detection, npm audit parsing, graceful failures
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCommands, runVerificationGate, formatFailureContext, captureRuntimeErrors, runDependencyAudit, isLikelyCommand } from "../verification-gate.ts";
import type { CaptureRuntimeErrorsOptions, DependencyAuditOptions } from "../verification-gate.ts";
import { validatePreferences } from "../preferences.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Discovery Tests ─────────────────────────────────────────────────────────

test("verification-gate: discoverCommands from preference commands", () => {
  const tmp = makeTempDir("vg-pref");
  try {
    const result = discoverCommands({
      preferenceCommands: ["npm run lint", "npm run test"],
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
    assert.equal(result.source, "preference");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: discoverCommands from task plan verify field", () => {
  const tmp = makeTempDir("vg-taskplan");
  try {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
    assert.equal(result.source, "task-plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: discoverCommands from package.json scripts", () => {
  const tmp = makeTempDir("vg-pkg");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest",
          build: "tsc", // should NOT be included
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "npm run typecheck",
      "npm run lint",
      "npm run test",
    ]);
    assert.equal(result.source, "package-json");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: first-non-empty-wins — preference beats task plan and package.json", () => {
  const tmp = makeTempDir("vg-precedence");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      preferenceCommands: ["custom-check"],
      taskPlanVerify: "npm run lint",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["custom-check"]);
    assert.equal(result.source, "preference");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: task plan verify beats package.json", () => {
  const tmp = makeTempDir("vg-tp-beats-pkg");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      taskPlanVerify: "custom-verify",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["custom-verify"]);
    assert.equal(result.source, "task-plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: missing package.json → 0 checks, source none", () => {
  const tmp = makeTempDir("vg-no-pkg");
  try {
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: package.json with no matching scripts → 0 checks", () => {
  const tmp = makeTempDir("vg-no-scripts");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", start: "node index.js" } }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: empty preference array falls through to task plan", () => {
  const tmp = makeTempDir("vg-empty-pref");
  try {
    const result = discoverCommands({
      preferenceCommands: [],
      taskPlanVerify: "echo ok",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["echo ok"]);
    assert.equal(result.source, "task-plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Execution Tests ─────────────────────────────────────────────────────────

test("verification-gate: all commands pass → gate passes", () => {
  const tmp = makeTempDir("vg-pass");
  try {
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T01",
      cwd: tmp,
      preferenceCommands: ["echo hello", "echo world"],
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 2);
    assert.equal(result.discoverySource, "preference");
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 0);
    assert.ok(result.checks[0].stdout.includes("hello"));
    assert.ok(result.checks[1].stdout.includes("world"));
    assert.equal(typeof result.timestamp, "number");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: one command fails → gate fails with exit code + stderr", () => {
  const tmp = makeTempDir("vg-fail");
  try {
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T01",
      cwd: tmp,
      preferenceCommands: ["echo ok", "sh -c 'echo err >&2; exit 1'"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 1);
    assert.ok(result.checks[1].stderr.includes("err"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: no commands discovered → gate passes with 0 checks", () => {
  const tmp = makeTempDir("vg-empty");
  try {
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T01",
      cwd: tmp,
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 0);
    assert.equal(result.discoverySource, "none");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: command not found → exit code 127", () => {
  const tmp = makeTempDir("vg-notfound");
  try {
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T01",
      cwd: tmp,
      preferenceCommands: ["__nonexistent_command_xyz_42__"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].exitCode !== 0, "should have non-zero exit code");
    assert.ok(result.checks[0].durationMs >= 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: no DEP0190 deprecation warning when running commands", () => {
  const tmp = makeTempDir("vg-dep0190");
  try {
    // Run a subprocess with --throw-deprecation so any DeprecationWarning
    // becomes a thrown error (non-zero exit). The fix passes the command
    // string to sh -c explicitly instead of using spawnSync(cmd, {shell:true}).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const gatePath = join(thisDir, "..", "verification-gate.ts");
    const resolverPath = join(thisDir, "resolve-ts.mjs");
    const script = [
      `import { runVerificationGate } from ${JSON.stringify(pathToFileURL(gatePath).href)};`,
      `runVerificationGate({`,
      `  basePath: ${JSON.stringify(tmp)},`,
      `  unitId: "T-DEP",`,
      `  cwd: ${JSON.stringify(tmp)},`,
      `  preferenceCommands: ["echo dep0190-check"],`,
      `});`,
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        "--throw-deprecation",
        "--experimental-strip-types",
        "--import", resolverPath,
        "--input-type=module",
        "-e", script,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );
    // With --throw-deprecation, any DeprecationWarning becomes a thrown error
    // causing a non-zero exit. Exit 0 proves no deprecation was emitted.
    assert.equal(
      child.status,
      0,
      `Expected exit 0 (no deprecation) but got ${child.status}. stderr: ${child.stderr}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: each check has durationMs", () => {
  const tmp = makeTempDir("vg-duration");
  try {
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T01",
      cwd: tmp,
      preferenceCommands: ["echo fast"],
    });
    assert.equal(result.checks.length, 1);
    assert.equal(typeof result.checks[0].durationMs, "number");
    assert.ok(result.checks[0].durationMs >= 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Preference Validation Tests ─────────────────────────────────────────────

test("verification-gate: validatePreferences accepts valid verification keys", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", "npm run test"],
    verification_auto_fix: true,
    verification_max_retries: 3,
  });
  assert.deepStrictEqual(result.preferences.verification_commands, [
    "npm run lint",
    "npm run test",
  ]);
  assert.equal(result.preferences.verification_auto_fix, true);
  assert.equal(result.preferences.verification_max_retries, 3);
  assert.equal(result.errors.length, 0);
});

test("verification-gate: validatePreferences rejects non-array verification_commands", () => {
  const result = validatePreferences({
    verification_commands: "npm run lint" as unknown as string[],
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, undefined);
});

test("verification-gate: validatePreferences rejects non-boolean verification_auto_fix", () => {
  const result = validatePreferences({
    verification_auto_fix: "yes" as unknown as boolean,
  });
  assert.ok(result.errors.some((e) => e.includes("verification_auto_fix")));
  assert.equal(result.preferences.verification_auto_fix, undefined);
});

test("verification-gate: validatePreferences rejects negative verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: -1,
  });
  assert.ok(result.errors.some((e) => e.includes("verification_max_retries")));
  assert.equal(result.preferences.verification_max_retries, undefined);
});

test("verification-gate: validatePreferences rejects non-string items in verification_commands", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", 42 as unknown as string],
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, undefined);
});

test("verification-gate: validatePreferences floors verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: 2.7,
  });
  assert.equal(result.preferences.verification_max_retries, 2);
  assert.equal(result.errors.length, 0);
});

// ─── Additional Discovery Tests (T02) ───────────────────────────────────────

test("verification-gate: package.json with only test script → returns only npm run test", () => {
  const tmp = makeTempDir("vg-only-test");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest",
          build: "tsc",
          start: "node index.js",
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, ["npm run test"]);
    assert.equal(result.source, "package-json");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: taskPlanVerify with single command (no &&)", () => {
  const tmp = makeTempDir("vg-tp-single");
  try {
    const result = discoverCommands({
      taskPlanVerify: "npm test",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm test"]);
    assert.equal(result.source, "task-plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: whitespace-only preference commands fall through", () => {
  const tmp = makeTempDir("vg-ws-pref");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      preferenceCommands: ["  ", ""],
      cwd: tmp,
    });
    // Whitespace-only strings are trimmed to empty and filtered out
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run lint"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── isLikelyCommand Tests (issue #1066) ────────────────────────────────────

test("isLikelyCommand: known command prefixes are accepted", () => {
  assert.equal(isLikelyCommand("npm run lint"), true);
  assert.equal(isLikelyCommand("npx vitest"), true);
  assert.equal(isLikelyCommand("yarn test"), true);
  assert.equal(isLikelyCommand("pnpm run typecheck"), true);
  assert.equal(isLikelyCommand("node script.js"), true);
  assert.equal(isLikelyCommand("tsc --noEmit"), true);
  assert.equal(isLikelyCommand("eslint ."), true);
  assert.equal(isLikelyCommand("jest --ci"), true);
  assert.equal(isLikelyCommand("python3 -m pytest"), true);
  assert.equal(isLikelyCommand("cargo test"), true);
  assert.equal(isLikelyCommand("go test ./..."), true);
  assert.equal(isLikelyCommand("make test"), true);
});

test("isLikelyCommand: path-like first tokens are accepted", () => {
  assert.equal(isLikelyCommand("./scripts/verify.sh"), true);
  assert.equal(isLikelyCommand("/usr/local/bin/check"), true);
  assert.equal(isLikelyCommand("../tools/lint.sh"), true);
});

test("isLikelyCommand: flag-like tokens indicate a command", () => {
  assert.equal(isLikelyCommand("custom-tool --check"), true);
  assert.equal(isLikelyCommand("mycheck -v"), true);
});

test("isLikelyCommand: prose descriptions are rejected", () => {
  // The exact string from issue #1066
  assert.equal(
    isLikelyCommand("Document exists, contains all 5 scale names, all 14 semantic tokens, Inter assessment, philosophy and competitive citations present"),
    false,
  );
  assert.equal(isLikelyCommand("Check that the file has been created with the correct content"), false);
  assert.equal(isLikelyCommand("Verify the output matches expected format"), false);
  assert.equal(isLikelyCommand("All tests pass and coverage is above 80%"), false);
  assert.equal(isLikelyCommand("File should exist in the output directory"), false);
  assert.equal(isLikelyCommand("Build succeeds without errors or warnings"), false);
});

test("isLikelyCommand: empty or whitespace-only strings are rejected", () => {
  assert.equal(isLikelyCommand(""), false);
  assert.equal(isLikelyCommand("   "), false);
});

test("isLikelyCommand: short lowercase tokens without flags are accepted (could be custom scripts)", () => {
  assert.equal(isLikelyCommand("custom-verify"), true);
  assert.equal(isLikelyCommand("mycheck"), true);
});

test("verification-gate: prose taskPlanVerify is rejected, falls through to package.json", () => {
  const tmp = makeTempDir("vg-prose-reject");
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const result = discoverCommands({
      taskPlanVerify: "Document exists, contains all 5 scale names, all 14 semantic tokens",
      cwd: tmp,
    });
    // Prose should be rejected, so it falls through to package.json
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: prose taskPlanVerify with no package.json → source none", () => {
  const tmp = makeTempDir("vg-prose-none");
  try {
    const result = discoverCommands({
      taskPlanVerify: "Verify the output matches expected format and all fields are present",
      cwd: tmp,
    });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: valid command in taskPlanVerify still works", () => {
  const tmp = makeTempDir("vg-valid-cmd");
  try {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: mixed prose and commands in taskPlanVerify — only commands kept", () => {
  const tmp = makeTempDir("vg-mixed");
  try {
    const result = discoverCommands({
      taskPlanVerify: "Check that everything works && npm run test",
      cwd: tmp,
    });
    // "Check that everything works" is prose (starts with capital, 4+ words)
    // "npm run test" is a valid command
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Additional Execution Tests (T02) ───────────────────────────────────────

test("verification-gate: one command fails — remaining commands still run (non-short-circuit)", () => {
  const tmp = makeTempDir("vg-no-short-circuit");
  try {
    // First fails, second and third should still execute
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T02",
      cwd: tmp,
      preferenceCommands: [
        "sh -c 'exit 1'",
        "echo second",
        "echo third",
      ],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 3, "all 3 commands should run");
    assert.equal(result.checks[0].exitCode, 1, "first command fails");
    assert.equal(result.checks[1].exitCode, 0, "second command runs and passes");
    assert.ok(result.checks[1].stdout.includes("second"));
    assert.equal(result.checks[2].exitCode, 0, "third command runs and passes");
    assert.ok(result.checks[2].stdout.includes("third"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-gate: gate execution uses cwd for spawnSync", () => {
  const tmp = makeTempDir("vg-cwd");
  try {
    // pwd should report the temp dir
    const result = runVerificationGate({
      basePath: tmp,
      unitId: "T02",
      cwd: tmp,
      preferenceCommands: ["pwd"],
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    // The stdout should contain the tmp dir path (resolving symlinks)
    assert.ok(result.checks[0].stdout.trim().length > 0, "pwd should produce output");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Additional Preference Validation Tests (T02) ──────────────────────────

test("verification-gate: verification_commands produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_commands: ["npm test"],
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_commands is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_auto_fix produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_auto_fix: true,
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_auto_fix is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_max_retries produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_max_retries: 2,
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_max_retries is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_max_retries -1 produces a validation error", () => {
  const result = validatePreferences({
    verification_max_retries: -1,
  });
  assert.ok(
    result.errors.some(e => e.includes("verification_max_retries")),
    "negative max_retries should error",
  );
  assert.equal(result.preferences.verification_max_retries, undefined);
});

// ─── formatFailureContext Tests (S03/T01) ─────────────────────────────────────

test("formatFailureContext: formats a single failure with command, exit code, stderr", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "error: unused var", durationMs: 500 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.startsWith("## Verification Failures"), "should start with header");
  assert.ok(output.includes("`npm run lint`"), "should include command name");
  assert.ok(output.includes("exit code 1"), "should include exit code");
  assert.ok(output.includes("error: unused var"), "should include stderr content");
  assert.ok(output.includes("```stderr"), "should have stderr code block");
});

test("formatFailureContext: formats multiple failures", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "lint error", durationMs: 100 },
      { command: "npm run test", exitCode: 2, stdout: "", stderr: "test failure", durationMs: 200 },
      { command: "npm run typecheck", exitCode: 0, stdout: "ok", stderr: "", durationMs: 50 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.includes("`npm run lint`"), "should include first failed command");
  assert.ok(output.includes("exit code 1"), "should include first exit code");
  assert.ok(output.includes("`npm run test`"), "should include second failed command");
  assert.ok(output.includes("exit code 2"), "should include second exit code");
  // Passing check should NOT appear
  assert.ok(!output.includes("npm run typecheck"), "should not include passing command");
});

test("formatFailureContext: truncates stderr longer than 2000 chars", () => {
  const longStderr = "x".repeat(3000);
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "big-err", exitCode: 1, stdout: "", stderr: longStderr, durationMs: 100 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  // The output should contain 2000 x's followed by truncation marker, not 3000
  assert.ok(!output.includes("x".repeat(2001)), "should not contain more than 2000 chars of stderr");
  assert.ok(output.includes("…[truncated]"), "should include truncation marker");
});

test("formatFailureContext: returns empty string when all checks pass", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 200 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  assert.equal(formatFailureContext(result), "");
});

test("formatFailureContext: returns empty string for empty checks array", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: true,
    checks: [],
    discoverySource: "none",
    timestamp: Date.now(),
  };
  assert.equal(formatFailureContext(result), "");
});

test("formatFailureContext: caps total output at 10,000 chars", () => {
  // Generate many failures to exceed 10,000 chars total
  const checks: import("../types.ts").VerificationCheck[] = [];
  for (let i = 0; i < 20; i++) {
    checks.push({
      command: `failing-command-${i}`,
      exitCode: 1,
      stdout: "",
      stderr: "e".repeat(1000), // 1000 chars each, 20 * ~1050 (with formatting) > 10,000
      durationMs: 100,
    });
  }
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks,
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.length <= 10_100, `total output should be capped near 10,000 chars, got ${output.length}`);
  assert.ok(output.includes("…[remaining failures truncated]"), "should include total truncation marker");
});

// ─── captureRuntimeErrors Tests (S04/T01) ─────────────────────────────────────

function makeProc(overrides: Record<string, unknown>) {
  return {
    id: "p1",
    label: "test-server",
    status: "ready",
    alive: true,
    exitCode: null,
    signal: null,
    recentErrors: [] as string[],
    ...overrides,
  };
}

function makeLogs(entries: Array<{ type: string; text: string }>) {
  return entries.map((e, i) => ({
    type: e.type,
    text: e.text,
    timestamp: Date.now() + i,
    url: "http://localhost:3000",
  }));
}

test("captureRuntimeErrors: crashed bg-shell process → blocking crash error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("test-server"));
});

test("captureRuntimeErrors: bg-shell non-zero exit + not alive → blocking crash error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "exited", alive: false, exitCode: 137 })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("exitCode=137"));
});

test("captureRuntimeErrors: bg-shell SIGABRT/SIGSEGV/SIGBUS → blocking crash error", async () => {
  for (const sig of ["SIGABRT", "SIGSEGV", "SIGBUS"]) {
    const processes = new Map<string, unknown>([
      ["p1", makeProc({ signal: sig, alive: false, exitCode: null })],
    ]);
    const result = await captureRuntimeErrors({
      getProcesses: () => processes,
      getConsoleLogs: () => [],
    });
    assert.equal(result.length, 1, `${sig} should produce 1 error`);
    assert.equal(result[0].severity, "crash");
    assert.equal(result[0].blocking, true);
    assert.ok(result[0].message.includes(sig), `message should contain ${sig}`);
  }
});

test("captureRuntimeErrors: alive bg-shell process with recentErrors → non-blocking error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ alive: true, recentErrors: ["TypeError: foo", "RangeError: bar"] })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("TypeError: foo"));
  assert.ok(result[0].message.includes("RangeError: bar"));
});

test("captureRuntimeErrors: browser unhandled rejection → blocking crash error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Unhandled promise rejection: some error" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("Unhandled"));
});

test("captureRuntimeErrors: browser UnhandledRejection (case variation) → blocking crash", async () => {
  const logs = makeLogs([
    { type: "error", text: "UnhandledRejection in module X" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
});

test("captureRuntimeErrors: browser console.error (general) → non-blocking error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Failed to load resource: net::ERR_FAILED" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
});

test("captureRuntimeErrors: browser deprecation warning → non-blocking warning", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Event.returnValue is deprecated. Use Event.preventDefault() instead." },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "warning");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("deprecated"));
});

test("captureRuntimeErrors: non-deprecation warning is ignored", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Some general warning about performance" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 0, "non-deprecation warnings should be ignored");
});

test("captureRuntimeErrors: no processes, no browser logs → empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => [],
  });
  assert.deepStrictEqual(result, []);
});

test("captureRuntimeErrors: dynamic import failure → graceful empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => { throw new Error("module not found"); },
    getConsoleLogs: () => { throw new Error("module not found"); },
  });
  assert.deepStrictEqual(result, []);
});

test("captureRuntimeErrors: browser text truncated to 500 chars", async () => {
  const longText = "x".repeat(600);
  const logs = makeLogs([
    { type: "error", text: longText },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.length <= 500 + 20, "message should be truncated near 500 chars");
  assert.ok(result[0].message.includes("…[truncated]"), "should include truncation marker");
  assert.ok(!result[0].message.includes("x".repeat(501)), "should not contain 501+ x's");
});

test("captureRuntimeErrors: bg-shell recentErrors limited to 3 in message", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({
      status: "crashed",
      alive: false,
      exitCode: 1,
      recentErrors: ["err1", "err2", "err3", "err4", "err5"],
    })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.includes("err1"));
  assert.ok(result[0].message.includes("err2"));
  assert.ok(result[0].message.includes("err3"));
  assert.ok(!result[0].message.includes("err4"), "should only include first 3 errors");
});

test("captureRuntimeErrors: mixed bg-shell and browser errors", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })],
  ]);
  const logs = makeLogs([
    { type: "error", text: "Unhandled rejection: boom" },
    { type: "error", text: "general error" },
    { type: "warning", text: "deprecated API used" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => logs,
  });
  // 1 bg-shell crash + 1 browser crash (unhandled) + 1 browser error + 1 browser warning
  assert.equal(result.length, 4);
  const blocking = result.filter(r => r.blocking);
  const nonBlocking = result.filter(r => !r.blocking);
  assert.equal(blocking.length, 2, "should have 2 blocking errors");
  assert.equal(nonBlocking.length, 2, "should have 2 non-blocking errors");
});

// ─── Dependency Audit Tests (S05/T01) ─────────────────────────────────────────

/** Helper: build a realistic npm audit JSON stdout with vulnerabilities. */
function makeAuditJson(
  vulns: Record<string, { severity: string; fixAvailable: boolean; via: unknown[] }>,
): string {
  return JSON.stringify({ vulnerabilities: vulns });
}

/** Sample npm audit JSON with a high-severity vuln. */
const SAMPLE_AUDIT_JSON = makeAuditJson({
  "nth-check": {
    severity: "high",
    fixAvailable: true,
    via: [
      {
        title: "Inefficient Regular Expression Complexity in nth-check",
        url: "https://github.com/advisories/GHSA-rp65-9cf3-cjxr",
        severity: "high",
      },
    ],
  },
});

test("dependency-audit: package.json in git diff → runs npm audit and parses vulnerabilities", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json", "src/index.ts"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true, "npm audit should be called");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
  assert.equal(result[0].title, "Inefficient Regular Expression Complexity in nth-check");
  assert.equal(result[0].url, "https://github.com/advisories/GHSA-rp65-9cf3-cjxr");
  assert.equal(result[0].fixAvailable, true);
});

test("dependency-audit: package-lock.json change triggers audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
  assert.equal(result.length, 1);
});

test("dependency-audit: pnpm-lock.yaml change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["pnpm-lock.yaml"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: yarn.lock change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["yarn.lock"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: bun.lockb change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["bun.lockb"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: no dependency file changes → returns empty array, npm audit not called", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["src/index.ts", "README.md"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: "{}", exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, false, "npm audit should NOT be called when no dependency files changed");
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: git diff returns non-zero exit (not a git repo) → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => { throw new Error("not a git repo"); },
    npmAudit: () => { throw new Error("should not be called"); },
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit returns invalid JSON → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: "not json at all", exitCode: 1 }),
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit returns zero vulnerabilities → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({
      stdout: JSON.stringify({ vulnerabilities: {} }),
      exitCode: 0,
    }),
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit non-zero exit with valid JSON → parses correctly", () => {
  // npm audit exits non-zero when vulnerabilities exist — this is expected, not an error
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => ({
      stdout: SAMPLE_AUDIT_JSON,
      exitCode: 1, // non-zero!
    }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
});

test("dependency-audit: via entries with string-only values are skipped", () => {
  const auditJson = makeAuditJson({
    "postcss": {
      severity: "moderate",
      fixAvailable: false,
      via: ["nth-check", "css-select"], // string-only via entries
    },
  });
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: auditJson, exitCode: 1 }),
  });
  assert.equal(result.length, 1);
  // When no object via entry is found, title falls back to the package name
  assert.equal(result[0].name, "postcss");
  assert.equal(result[0].title, "postcss");
  assert.equal(result[0].url, "");
});

test("dependency-audit: subdirectory package.json does not trigger audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["packages/foo/package.json", "libs/bar/package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, false, "subdirectory dependency files should not trigger audit");
  assert.deepStrictEqual(result, []);
});
