/**
 * Unit tests for the verification evidence module — JSON persistence and markdown table formatting.
 *
 * Tests cover:
 *   1. writeVerificationJSON writes correct JSON shape (schemaVersion, taskId, timestamp, passed, discoverySource, checks)
 *   2. writeVerificationJSON creates directory if it doesn't exist
 *   3. writeVerificationJSON maps exitCode to verdict correctly (0 = pass, non-zero = fail)
 *   4. writeVerificationJSON excludes stdout/stderr from output
 *   5. writeVerificationJSON handles empty checks array
 *   6. writeVerificationJSON accepts optional unitId
 *   7. formatEvidenceTable returns markdown table with correct columns for checks
 *   8. formatEvidenceTable returns "no checks" message for empty checks
 *   9. formatEvidenceTable formats duration as seconds with 1 decimal
 *  10. formatEvidenceTable uses ✅/❌ emoji for pass/fail verdict
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeVerificationJSON,
  formatEvidenceTable,
} from "../verification-evidence.ts";
import type { VerificationResult } from "../types.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeResult(overrides?: Partial<VerificationResult>): VerificationResult {
  return {
    passed: true,
    checks: [],
    discoverySource: "package-json",
    timestamp: 1710000000000,
    ...overrides,
  };
}

// ─── writeVerificationJSON Tests ─────────────────────────────────────────────

test("verification-evidence: writeVerificationJSON writes correct JSON shape", () => {
  const tmp = makeTempDir("ve-shape");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        {
          command: "npm run typecheck",
          exitCode: 0,
          stdout: "all good",
          stderr: "",
          durationMs: 2340,
        },
      ],
    });

    writeVerificationJSON(result, tmp, "T03");

    const filePath = join(tmp, "T03-VERIFY.json");
    assert.ok(existsSync(filePath), "JSON file should exist");

    const json = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.taskId, "T03");
    assert.equal(json.unitId, "T03"); // defaults to taskId when unitId not provided
    assert.equal(json.timestamp, 1710000000000);
    assert.equal(json.passed, true);
    assert.equal(json.discoverySource, "package-json");
    assert.equal(json.checks.length, 1);
    assert.equal(json.checks[0].command, "npm run typecheck");
    assert.equal(json.checks[0].exitCode, 0);
    assert.equal(json.checks[0].durationMs, 2340);
    assert.equal(json.checks[0].verdict, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON creates directory if it doesn't exist", () => {
  const tmp = makeTempDir("ve-mkdir");
  const nested = join(tmp, "deep", "nested", "tasks");
  try {
    assert.ok(!existsSync(nested), "directory should not exist yet");

    writeVerificationJSON(makeResult(), nested, "T01");

    assert.ok(existsSync(nested), "directory should be created");
    assert.ok(existsSync(join(nested, "T01-VERIFY.json")), "JSON file should exist");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON maps exitCode to verdict correctly", () => {
  const tmp = makeTempDir("ve-verdict");
  try {
    const result = makeResult({
      passed: false,
      checks: [
        { command: "lint", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
        { command: "test", exitCode: 1, stdout: "", stderr: "fail", durationMs: 200 },
        { command: "audit", exitCode: 2, stdout: "", stderr: "err", durationMs: 300 },
      ],
    });

    writeVerificationJSON(result, tmp, "T02");

    const json = JSON.parse(readFileSync(join(tmp, "T02-VERIFY.json"), "utf-8"));
    assert.equal(json.checks[0].verdict, "pass");
    assert.equal(json.checks[1].verdict, "fail");
    assert.equal(json.checks[2].verdict, "fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON excludes stdout/stderr from output", () => {
  const tmp = makeTempDir("ve-no-stdio");
  try {
    const result = makeResult({
      checks: [
        {
          command: "echo hello",
          exitCode: 0,
          stdout: "hello\n",
          stderr: "some warning",
          durationMs: 50,
        },
      ],
    });

    writeVerificationJSON(result, tmp, "T01");

    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"stdout"'), "JSON should not contain stdout key");
    assert.ok(!raw.includes('"stderr"'), "JSON should not contain stderr key");
    assert.ok(!raw.includes("hello\\n"), "JSON should not contain stdout value");
    assert.ok(!raw.includes("some warning"), "JSON should not contain stderr value");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON handles empty checks array", () => {
  const tmp = makeTempDir("ve-empty");
  try {
    writeVerificationJSON(makeResult({ checks: [] }), tmp, "T01");

    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.passed, true);
    assert.deepStrictEqual(json.checks, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON uses optional unitId when provided", () => {
  const tmp = makeTempDir("ve-unitid");
  try {
    writeVerificationJSON(makeResult(), tmp, "T03", "M001/S01/T03");

    const json = JSON.parse(readFileSync(join(tmp, "T03-VERIFY.json"), "utf-8"));
    assert.equal(json.taskId, "T03");
    assert.equal(json.unitId, "M001/S01/T03");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── formatEvidenceTable Tests ───────────────────────────────────────────────

test("verification-evidence: formatEvidenceTable returns markdown table with correct columns", () => {
  const result = makeResult({
    checks: [
      { command: "npm run typecheck", exitCode: 0, stdout: "", stderr: "", durationMs: 2340 },
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "err", durationMs: 1100 },
    ],
  });

  const table = formatEvidenceTable(result);
  const lines = table.split("\n");

  // Header row
  assert.ok(lines[0].includes("# |"), "header should have # column");
  assert.ok(lines[0].includes("Command"), "header should have Command column");
  assert.ok(lines[0].includes("Exit Code"), "header should have Exit Code column");
  assert.ok(lines[0].includes("Verdict"), "header should have Verdict column");
  assert.ok(lines[0].includes("Duration"), "header should have Duration column");

  // Separator row
  assert.ok(lines[1].includes("---|"), "should have separator row");

  // Data rows
  assert.equal(lines.length, 4, "header + separator + 2 data rows");
  assert.ok(lines[2].includes("npm run typecheck"), "first row command");
  assert.ok(lines[3].includes("npm run lint"), "second row command");
});

test("verification-evidence: formatEvidenceTable returns no-checks message for empty checks", () => {
  const result = makeResult({ checks: [] });
  const output = formatEvidenceTable(result);
  assert.equal(output, "_No verification checks discovered._");
});

test("verification-evidence: formatEvidenceTable formats duration as seconds with 1 decimal", () => {
  const result = makeResult({
    checks: [
      { command: "fast", exitCode: 0, stdout: "", stderr: "", durationMs: 150 },
      { command: "slow", exitCode: 0, stdout: "", stderr: "", durationMs: 2340 },
      { command: "zero", exitCode: 0, stdout: "", stderr: "", durationMs: 0 },
    ],
  });

  const table = formatEvidenceTable(result);
  assert.ok(table.includes("0.1s"), "150ms → 0.1s");
  assert.ok(table.includes("2.3s"), "2340ms → 2.3s");
  assert.ok(table.includes("0.0s"), "0ms → 0.0s");
});

test("verification-evidence: formatEvidenceTable uses ✅/❌ emoji for pass/fail verdict", () => {
  const result = makeResult({
    passed: false,
    checks: [
      { command: "pass-cmd", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
      { command: "fail-cmd", exitCode: 1, stdout: "", stderr: "", durationMs: 200 },
    ],
  });

  const table = formatEvidenceTable(result);
  assert.ok(table.includes("✅ pass"), "passing check should have ✅ pass");
  assert.ok(table.includes("❌ fail"), "failing check should have ❌ fail");
});

// ─── Retry Evidence Field Tests (S03/T01) ─────────────────────────────────────

test("verification-evidence: writeVerificationJSON with retryAttempt and maxRetries includes them in output", () => {
  const tmp = makeTempDir("ve-retry-fields");
  try {
    const result = makeResult({
      passed: false,
      checks: [
        { command: "npm run lint", exitCode: 1, stdout: "", stderr: "error", durationMs: 300 },
      ],
    });

    writeVerificationJSON(result, tmp, "T01", "M001/S03/T01", 1, 2);

    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.equal(json.retryAttempt, 1, "retryAttempt should be 1");
    assert.equal(json.maxRetries, 2, "maxRetries should be 2");
    // Other fields should still be correct
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.taskId, "T01");
    assert.equal(json.unitId, "M001/S03/T01");
    assert.equal(json.passed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON without retry params omits retryAttempt/maxRetries keys", () => {
  const tmp = makeTempDir("ve-no-retry");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      ],
    });

    writeVerificationJSON(result, tmp, "T02");

    const raw = readFileSync(join(tmp, "T02-VERIFY.json"), "utf-8");
    const json = JSON.parse(raw);
    assert.ok(!("retryAttempt" in json), "retryAttempt key should not be present");
    assert.ok(!("maxRetries" in json), "maxRetries key should not be present");
    // Confirm the JSON string does not contain these keys at all
    assert.ok(!raw.includes('"retryAttempt"'), "raw JSON should not contain retryAttempt");
    assert.ok(!raw.includes('"maxRetries"'), "raw JSON should not contain maxRetries");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Runtime Error Evidence Tests (S04/T02) ──────────────────────────────────

test("verification-evidence: writeVerificationJSON includes runtimeErrors when present", () => {
  const tmp = makeTempDir("ve-rt-present");
  try {
    const result = makeResult({
      passed: false,
      checks: [
        { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      ],
      runtimeErrors: [
        { source: "bg-shell", severity: "crash", message: "Server crashed", blocking: true },
        { source: "browser", severity: "error", message: "Uncaught TypeError", blocking: false },
      ],
    });

    writeVerificationJSON(result, tmp, "T01");

    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.ok(Array.isArray(json.runtimeErrors), "runtimeErrors should be an array");
    assert.equal(json.runtimeErrors.length, 2, "should have 2 runtime errors");
    assert.equal(json.runtimeErrors[0].source, "bg-shell");
    assert.equal(json.runtimeErrors[0].severity, "crash");
    assert.equal(json.runtimeErrors[0].message, "Server crashed");
    assert.equal(json.runtimeErrors[0].blocking, true);
    assert.equal(json.runtimeErrors[1].source, "browser");
    assert.equal(json.runtimeErrors[1].severity, "error");
    assert.equal(json.runtimeErrors[1].message, "Uncaught TypeError");
    assert.equal(json.runtimeErrors[1].blocking, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON omits runtimeErrors when absent", () => {
  const tmp = makeTempDir("ve-rt-absent");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 50 },
      ],
    });

    writeVerificationJSON(result, tmp, "T01");

    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"runtimeErrors"'), "raw JSON should not contain runtimeErrors key");
    const json = JSON.parse(raw);
    assert.ok(!("runtimeErrors" in json), "runtimeErrors key should not be present in parsed JSON");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON omits runtimeErrors when empty array", () => {
  const tmp = makeTempDir("ve-rt-empty");
  try {
    const result = makeResult({
      passed: true,
      checks: [],
      runtimeErrors: [],
    });

    writeVerificationJSON(result, tmp, "T01");

    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"runtimeErrors"'), "raw JSON should not contain runtimeErrors key when empty array");
    const json = JSON.parse(raw);
    assert.ok(!("runtimeErrors" in json), "runtimeErrors key should not be present for empty array");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: formatEvidenceTable appends runtime errors section", () => {
  const result = makeResult({
    passed: false,
    checks: [
      { command: "npm run test", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
    ],
    runtimeErrors: [
      { source: "bg-shell", severity: "crash", message: "Server crashed with SIGKILL", blocking: true },
      { source: "browser", severity: "warning", message: "Deprecated API usage", blocking: false },
    ],
  });

  const table = formatEvidenceTable(result);

  // Should contain runtime errors section
  assert.ok(table.includes("**Runtime Errors**"), "should have Runtime Errors heading");
  assert.ok(table.includes("| # | Source | Severity | Blocking | Message |"), "should have runtime errors column headers");
  assert.ok(table.includes("bg-shell"), "should contain bg-shell source");
  assert.ok(table.includes("crash"), "should contain crash severity");
  assert.ok(table.includes("🚫 yes"), "blocking error should show 🚫 yes");
  assert.ok(table.includes("ℹ️ no"), "non-blocking error should show ℹ️ no");
  assert.ok(table.includes("Server crashed with SIGKILL"), "should contain error message");
  assert.ok(table.includes("Deprecated API usage"), "should contain warning message");
});

test("verification-evidence: formatEvidenceTable omits runtime errors section when none", () => {
  const result = makeResult({
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 200 },
    ],
  });

  const table = formatEvidenceTable(result);

  assert.ok(!table.includes("Runtime Errors"), "should not contain Runtime Errors heading");
  assert.ok(table.includes("npm run lint"), "should still contain the check table");
});

test("verification-evidence: formatEvidenceTable truncates runtime error message to 100 chars", () => {
  const longMessage = "A".repeat(150);
  const result = makeResult({
    passed: false,
    checks: [
      { command: "npm run test", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
    ],
    runtimeErrors: [
      { source: "bg-shell", severity: "error", message: longMessage, blocking: false },
    ],
  });

  const table = formatEvidenceTable(result);

  // The table should contain the truncated message (100 chars), not the full 150
  assert.ok(table.includes("A".repeat(100)), "should contain 100 A's");
  assert.ok(!table.includes("A".repeat(101)), "should not contain 101 A's (truncated)");
});

// ─── Audit Warning Evidence Tests (S05/T02) ──────────────────────────────────

const SAMPLE_AUDIT_WARNINGS = [
  {
    name: "lodash",
    severity: "critical" as const,
    title: "Prototype Pollution",
    url: "https://github.com/advisories/GHSA-1234",
    fixAvailable: true,
  },
  {
    name: "express",
    severity: "high" as const,
    title: "Open Redirect",
    url: "https://github.com/advisories/GHSA-5678",
    fixAvailable: false,
  },
  {
    name: "minimist",
    severity: "moderate" as const,
    title: "Prototype Pollution",
    url: "https://github.com/advisories/GHSA-9012",
    fixAvailable: true,
  },
];

test("verification-evidence: writeVerificationJSON includes auditWarnings when present", () => {
  const tmp = makeTempDir("ve-audit-present");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      ],
      auditWarnings: SAMPLE_AUDIT_WARNINGS,
    });

    writeVerificationJSON(result, tmp, "T01");

    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.ok(Array.isArray(json.auditWarnings), "auditWarnings should be an array");
    assert.equal(json.auditWarnings.length, 3, "should have 3 audit warnings");
    assert.equal(json.auditWarnings[0].name, "lodash");
    assert.equal(json.auditWarnings[0].severity, "critical");
    assert.equal(json.auditWarnings[0].title, "Prototype Pollution");
    assert.equal(json.auditWarnings[0].url, "https://github.com/advisories/GHSA-1234");
    assert.equal(json.auditWarnings[0].fixAvailable, true);
    assert.equal(json.auditWarnings[1].name, "express");
    assert.equal(json.auditWarnings[1].severity, "high");
    assert.equal(json.auditWarnings[1].fixAvailable, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON omits auditWarnings when absent", () => {
  const tmp = makeTempDir("ve-audit-absent");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 50 },
      ],
    });

    writeVerificationJSON(result, tmp, "T01");

    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"auditWarnings"'), "raw JSON should not contain auditWarnings key");
    const json = JSON.parse(raw);
    assert.ok(!("auditWarnings" in json), "auditWarnings key should not be present in parsed JSON");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: writeVerificationJSON omits auditWarnings when empty array", () => {
  const tmp = makeTempDir("ve-audit-empty");
  try {
    const result = makeResult({
      passed: true,
      checks: [],
      auditWarnings: [],
    });

    writeVerificationJSON(result, tmp, "T01");

    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"auditWarnings"'), "raw JSON should not contain auditWarnings key when empty array");
    const json = JSON.parse(raw);
    assert.ok(!("auditWarnings" in json), "auditWarnings key should not be present for empty array");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verification-evidence: formatEvidenceTable appends audit warnings section", () => {
  const result = makeResult({
    passed: true,
    checks: [
      { command: "npm run test", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
    ],
    auditWarnings: SAMPLE_AUDIT_WARNINGS,
  });

  const table = formatEvidenceTable(result);

  assert.ok(table.includes("**Audit Warnings**"), "should have Audit Warnings heading");
  assert.ok(table.includes("| # | Package | Severity | Title | Fix Available |"), "should have audit warnings column headers");
  assert.ok(table.includes("lodash"), "should contain lodash package");
  assert.ok(table.includes("🔴 critical"), "should show critical emoji");
  assert.ok(table.includes("🟠 high"), "should show high emoji");
  assert.ok(table.includes("🟡 moderate"), "should show moderate emoji");
  assert.ok(table.includes("Prototype Pollution"), "should contain vulnerability title");
  assert.ok(table.includes("Open Redirect"), "should contain vulnerability title");
  assert.ok(table.includes("✅ yes"), "fixAvailable true should show ✅ yes");
  assert.ok(table.includes("❌ no"), "fixAvailable false should show ❌ no");
});

test("verification-evidence: formatEvidenceTable omits audit warnings section when none", () => {
  const result = makeResult({
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 200 },
    ],
  });

  const table = formatEvidenceTable(result);

  assert.ok(!table.includes("Audit Warnings"), "should not contain Audit Warnings heading");
  assert.ok(table.includes("npm run lint"), "should still contain the check table");
});

test("verification-evidence: integration — VerificationResult with auditWarnings → JSON → table", () => {
  const tmp = makeTempDir("ve-audit-integration");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run typecheck", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1500 },
      ],
      auditWarnings: [
        {
          name: "got",
          severity: "moderate" as const,
          title: "Redirect bypass",
          url: "https://github.com/advisories/GHSA-abcd",
          fixAvailable: true,
        },
      ],
    });

    // 1. Write JSON and verify
    writeVerificationJSON(result, tmp, "T05");
    const json = JSON.parse(readFileSync(join(tmp, "T05-VERIFY.json"), "utf-8"));
    assert.equal(json.auditWarnings.length, 1, "JSON should have 1 audit warning");
    assert.equal(json.auditWarnings[0].name, "got");
    assert.equal(json.auditWarnings[0].severity, "moderate");
    assert.equal(json.auditWarnings[0].fixAvailable, true);
    // passed should still be true — audit warnings are non-blocking
    assert.equal(json.passed, true, "passed should remain true despite audit warnings");

    // 2. Format table and verify
    const table = formatEvidenceTable(result);
    assert.ok(table.includes("**Audit Warnings**"), "table should have Audit Warnings section");
    assert.ok(table.includes("got"), "table should contain package name");
    assert.ok(table.includes("🟡 moderate"), "table should show moderate severity with emoji");
    assert.ok(table.includes("Redirect bypass"), "table should contain vulnerability title");
    assert.ok(table.includes("✅ yes"), "table should show fix available");
    // Check table still has the main verification checks
    assert.ok(table.includes("npm run typecheck"), "table should still have main check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
