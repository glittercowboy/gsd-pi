/**
 * E2E integration tests for `gsd headless` runtime behavior.
 *
 * Spawns real `gsd headless` child processes and asserts on
 * stdout/stderr/exit-code for: JSON batch mode, SIGINT exit code,
 * stream-json NDJSON output, --resume error path, and invalid
 * --output-format handling.
 *
 * These tests are structural — they do NOT require API keys.
 *
 * Prerequisite: npm run build must be run first.
 *
 * Run with:
 *   node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test \
 *        src/tests/integration/e2e-headless.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const projectRoot = process.cwd();
const loaderPath = join(projectRoot, "dist", "loader.js");

if (!existsSync(loaderPath)) {
  throw new Error("dist/loader.js not found — run: npm run build");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

/**
 * Spawn `node dist/loader.js ...args` and collect output.
 */
function runGsd(
  args: string[],
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = {},
  cwd: string = projectRoot,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("node", [loaderPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/**
 * Spawn a child process with the ability to send signals mid-flight.
 * Returns both the child and a promise that resolves with the result.
 */
function spawnGsd(
  args: string[],
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = {},
  cwd: string = projectRoot,
): { child: ReturnType<typeof spawn>; result: Promise<RunResult> } {
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn("node", [loaderPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  child.stdin!.end();

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  const result = new Promise<RunResult>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });

  return { child, result };
}

/** Strip ANSI escape codes from a string. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Bootstrap a temp directory with .gsd/ structure (milestones + runtime). */
function createTempWithGsd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  return dir;
}

/** Assert no crash markers in output. */
function assertNoCrashMarkers(output: string): void {
  const crashMarkers = [
    "SyntaxError:",
    "ReferenceError:",
    "TypeError: Cannot read",
    "FATAL ERROR",
    "ERR_MODULE_NOT_FOUND",
    "Error: Cannot find module",
    "SIGSEGV",
    "SIGABRT",
  ];

  for (const marker of crashMarkers) {
    assert.ok(
      !output.includes(marker),
      `output should not contain crash marker '${marker}':\n${output.slice(0, 500)}`,
    );
  }
}

// ===========================================================================
// 1. JSON batch mode suppresses streaming — stdout is a single JSON result
// ===========================================================================

test("headless --output-format json emits a single HeadlessJsonResult on stdout", async (t) => {
  const tmpDir = createTempWithGsd("gsd-e2e-json-batch-");
  t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // --max-restarts 0 prevents retry loops which would emit multiple JSON results.
  // --timeout 2000 ensures the process completes quickly.
  // Will timeout/error (no API key) but JSON batch mode should emit one HeadlessJsonResult.
  const result = await runGsd(
    ["headless", "--output-format", "json", "--timeout", "2000", "--max-restarts", "0", "auto"],
    45_000,  // generous harness timeout — process needs ~4-6s (2s timeout + startup + cleanup)
    {},
    tmpDir,
  );

  assert.ok(!result.timedOut, "test harness should not time out");
  // Non-zero exit expected (no API key / timeout), but process may exit 0
  // if auto-mode detects a conflict and completes immediately.
  assert.ok(result.code !== null, "process should exit with a code");

  const stdout = result.stdout.trim();
  assert.ok(stdout.length > 0, `stdout should contain the JSON result, got empty. stderr: ${stripAnsi(result.stderr).slice(0, 300)}`);

  // Must parse as a single JSON object (not NDJSON with multiple lines)
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    assert.fail(
      `stdout should be valid JSON, got parse error: ${(e as Error).message}\nstdout: ${stdout.slice(0, 500)}`,
    );
  }

  // Assert HeadlessJsonResult shape
  assert.equal(typeof parsed.status, "string", "result should have a string 'status' field");
  assert.equal(typeof parsed.exitCode, "number", "result should have a number 'exitCode' field");
  assert.equal(typeof parsed.duration, "number", "result should have a number 'duration' field");
  assert.equal(typeof parsed.cost, "object", "result should have a 'cost' object");
  assert.equal(typeof parsed.toolCalls, "number", "result should have a number 'toolCalls' field");
  assert.equal(typeof parsed.events, "number", "result should have a number 'events' field");

  // Must NOT be NDJSON (multiple newline-separated JSON objects)
  const lines = stdout.split("\n").filter((l: string) => l.trim().length > 0);
  assert.equal(lines.length, 1, `expected exactly one JSON line in stdout, got ${lines.length}`);

  const combined = stripAnsi(result.stdout + result.stderr);
  assertNoCrashMarkers(combined);
});

// ===========================================================================
// 2. SIGINT produces exit code 11 (EXIT_CANCELLED)
// ===========================================================================

test("headless exits with code 11 after SIGINT", async (t) => {
  const tmpDir = createTempWithGsd("gsd-e2e-sigint-");
  t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // Spawn with long timeout and max-restarts 0 so the process stays alive
  // waiting for completion while we send SIGINT.
  const { child, result: resultPromise } = spawnGsd(
    ["headless", "--timeout", "60000", "--max-restarts", "0", "--context-text", "Test context for SIGINT", "new-milestone"],
    30_000,
    {},
    tmpDir,
  );

  // Wait for the explicit signal-handlers-ready marker that runHeadlessOnce()
  // emits to stderr immediately after registering the SIGINT handler. Earlier
  // stderr lines (extension load warnings, phase banners) come from before
  // the handler is registered, so matching the first byte is unsafe. Poll
  // deterministically rather than fixed-sleep.
  const READY_MARKER = "[headless] signal-handlers-ready";
  let stderrSoFar = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrSoFar += chunk.toString();
  });
  const readyDeadline = Date.now() + 15_000;
  while (!stderrSoFar.includes(READY_MARKER) && Date.now() < readyDeadline) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  // If the child exited without ever emitting the ready marker, the test
  // environment prevented the child from reaching SIGINT-handler registration
  // (e.g. an existing gsd session forced an immediate auto-mode conflict exit).
  // Skip explicitly rather than silently passing via a 0|1|11 branch.
  if (child.exitCode !== null && !stderrSoFar.includes(READY_MARKER)) {
    const earlyResult = await resultPromise;
    t.skip(
      `headless exited (code=${earlyResult.code}) before signal handler registration — ` +
      `cannot assert SIGINT contract in this environment.\n` +
      `stdout: ${earlyResult.stdout.slice(0, 200)}\n` +
      `stderr: ${earlyResult.stderr.slice(0, 200)}`,
    );
    return;
  }
  if (!stderrSoFar.includes(READY_MARKER)) {
    child.kill("SIGKILL");
    await resultPromise;
    assert.fail("headless did not emit signal-handlers-ready within 15s — SIGINT handler cannot be confirmed live");
  }

  // Handler is live. SIGINT must produce exit code 11 and the Interrupted
  // stderr marker — no false-negative escape branch.
  child.kill("SIGINT");

  const result = await resultPromise;
  assert.ok(!result.timedOut, "test harness should not time out");

  const stderr = stripAnsi(result.stderr);
  const combined = stripAnsi(result.stdout + result.stderr);
  assertNoCrashMarkers(combined);

  assert.ok(
    stderr.includes("Interrupted"),
    `expected stderr to contain the '[headless] Interrupted' marker after SIGINT, got:\n${stderr.slice(0, 600)}`,
  );
  assert.strictEqual(
    result.code, 11,
    `SIGINT contract: expected exit 11 (EXIT_CANCELLED), got ${result.code}\nstderr: ${stderr.slice(0, 600)}`,
  );
});

// ===========================================================================
// 3. stream-json emits NDJSON on stdout (each line is valid JSON)
// ===========================================================================

test("headless --output-format stream-json emits NDJSON on stdout", async (t) => {
  const tmpDir = createTempWithGsd("gsd-e2e-stream-json-");
  t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // --max-restarts 0 to prevent retry loops that extend runtime.
  const result = await runGsd(
    ["headless", "--output-format", "stream-json", "--timeout", "2000", "--max-restarts", "0", "auto"],
    45_000,  // generous harness timeout
    {},
    tmpDir,
  );

  assert.ok(!result.timedOut, "test harness should not time out");
  // Non-zero exit expected (no API key / timeout), but 0 is acceptable
  // if auto-mode completes immediately (session conflict).
  assert.ok(result.code !== null, "process should exit with a code");

  const stdout = result.stdout.trim();
  const combined = stripAnsi(result.stdout + result.stderr);
  assertNoCrashMarkers(combined);

  // A zero-event exit (stream-json produces no stdout) is possible when the
  // process errors before any event fires. The contract we care about —
  // "stream-json emits newline-delimited JSON" — is unverifiable in that
  // window. Skip explicitly rather than silently passing (#4843).
  if (stdout.length === 0) {
    t.skip(
      `stream-json produced no stdout events before exit (code=${result.code}) — ` +
      `NDJSON contract is unverifiable. stderr: ${stripAnsi(result.stderr).slice(0, 200)}`,
    );
    return;
  }

  const lines = stdout.split("\n").filter((l: string) => l.trim().length > 0);
  assert.ok(lines.length > 0, "non-empty stdout should decompose into at least one NDJSON line");

  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
    } catch (e) {
      assert.fail(
        `stdout line ${i + 1} is not valid JSON: ${(e as Error).message}\nline: ${lines[i].slice(0, 300)}`,
      );
    }
  }
});

// ===========================================================================
// 4. --resume with nonexistent ID exits 1 with clean error
// ===========================================================================

test("headless --resume with nonexistent ID exits 1 with descriptive error", async (t) => {
  const tmpDir = createTempWithGsd("gsd-e2e-resume-bad-");
  t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const result = await runGsd(
    ["headless", "--resume", "nonexistent-id-xyz", "--max-restarts", "0", "auto"],
    30_000,
    {},
    tmpDir,
  );

  assert.ok(!result.timedOut, "test harness should not time out");
  assert.strictEqual(result.code, 1, `expected exit 1, got ${result.code}`);

  const stderr = stripAnsi(result.stderr);

  // The error should mention the bad ID or "No session matching"
  assert.ok(
    stderr.includes("nonexistent-id-xyz") || stderr.includes("No session matching"),
    `stderr should mention the bad session ID or 'No session matching', got:\n${stderr.slice(0, 500)}`,
  );

  const combined = stripAnsi(result.stdout + result.stderr);
  assertNoCrashMarkers(combined);
});

// ===========================================================================
// 5. --output-format with invalid value exits 1 with helpful message
// ===========================================================================

test("headless --output-format with invalid value exits 1", async (t) => {
  const tmpDir = createTempWithGsd("gsd-e2e-bad-format-");
  t.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const result = await runGsd(
    ["headless", "--output-format", "invalid-format", "auto"],
    15_000,
    {},
    tmpDir,
  );

  assert.ok(!result.timedOut, "test harness should not time out");
  assert.strictEqual(result.code, 1, `expected exit 1, got ${result.code}`);

  const stderr = stripAnsi(result.stderr);

  // Should mention valid formats
  assert.ok(
    stderr.includes("text") && stderr.includes("json") && stderr.includes("stream-json"),
    `stderr should list valid output formats, got:\n${stderr.slice(0, 500)}`,
  );

  // Should mention what was provided
  assert.ok(
    stderr.includes("invalid-format"),
    `stderr should echo the invalid value, got:\n${stderr.slice(0, 500)}`,
  );

  const combined = stripAnsi(result.stdout + result.stderr);
  assertNoCrashMarkers(combined);
});
