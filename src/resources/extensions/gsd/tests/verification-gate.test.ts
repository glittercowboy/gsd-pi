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
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverCommands, runVerificationGate } from "../verification-gate.ts";
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
