/**
 * Verification Evidence — JSON persistence and markdown table formatting.
 *
 * Two pure-ish functions:
 *   - writeVerificationJSON: persists a machine-readable T##-VERIFY.json artifact
 *   - formatEvidenceTable:   returns a markdown evidence table string
 *
 * JSON schema uses schemaVersion: 1 for forward-compatibility.
 * stdout/stderr are intentionally excluded from the JSON to avoid unbounded file sizes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationResult } from "./types.ts";

// ─── JSON Evidence Artifact ──────────────────────────────────────────────────

export interface EvidenceCheckJSON {
  command: string;
  exitCode: number;
  durationMs: number;
  verdict: "pass" | "fail";
}

export interface RuntimeErrorJSON {
  source: "bg-shell" | "browser";
  severity: "crash" | "error" | "warning";
  message: string;
  blocking: boolean;
}

export interface AuditWarningJSON {
  name: string;
  severity: string;
  title: string;
  url: string;
  fixAvailable: boolean;
}

export interface BrowserEvidenceCheckJSON {
  description: string;
  passed: boolean;
  actual?: string;
  evidence?: string;
  error?: string;
}

export interface BrowserEvidenceJSON {
  url: string;
  passed: boolean;
  checks: BrowserEvidenceCheckJSON[];
  duration: number;
}

export interface PreExecutionCheckJSON {
  /** Check category: package, file, tool, endpoint, schema */
  category: "package" | "file" | "tool" | "endpoint" | "schema";
  /** What was checked (e.g., package name, file path) */
  target: string;
  /** Whether the check passed */
  passed: boolean;
  /** Human-readable message explaining the result */
  message: string;
  /** Whether this failure should block execution (only meaningful when passed=false) */
  blocking?: boolean;
}

export interface PostExecutionCheckJSON {
  /** Check category: import, signature, pattern */
  category: "import" | "signature" | "pattern";
  /** What was checked (e.g., file:line, function name) */
  target: string;
  /** Whether the check passed */
  passed: boolean;
  /** Human-readable message explaining the result */
  message: string;
  /** Whether this failure should block completion (only meaningful when passed=false) */
  blocking?: boolean;
}

export interface EvidenceJSON {
  schemaVersion: 1;
  taskId: string;
  unitId: string;
  timestamp: number;
  passed: boolean;
  discoverySource: string;
  checks: EvidenceCheckJSON[];
  retryAttempt?: number;
  maxRetries?: number;
  runtimeErrors?: RuntimeErrorJSON[];
  auditWarnings?: AuditWarningJSON[];
  browser?: BrowserEvidenceJSON;
  /** Pre-execution checks run before task execution (package existence, file refs, etc.) */
  preExecutionChecks?: PreExecutionCheckJSON[];
  /** Post-execution checks run after task completion (import resolution, signature drift, pattern consistency) */
  postExecutionChecks?: PostExecutionCheckJSON[];
}

/**
 * Write a T##-VERIFY.json artifact to the tasks directory.
 * Creates the directory with mkdirSync({ recursive: true }) if it doesn't exist.
 *
 * stdout/stderr are excluded from the JSON — the full output lives in VerificationResult
 * in memory and is logged to stderr during the gate run.
 */
export function writeVerificationJSON(
  result: VerificationResult,
  tasksDir: string,
  taskId: string,
  unitId?: string,
  retryAttempt?: number,
  maxRetries?: number,
): void {
  mkdirSync(tasksDir, { recursive: true });

  const evidence: EvidenceJSON = {
    schemaVersion: 1,
    taskId,
    unitId: unitId ?? taskId,
    timestamp: result.timestamp,
    passed: result.passed,
    discoverySource: result.discoverySource,
    checks: result.checks.map((check) => ({
      command: check.command,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      verdict: check.exitCode === 0 ? "pass" : "fail",
    })),
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  };

  if (result.runtimeErrors && result.runtimeErrors.length > 0) {
    evidence.runtimeErrors = result.runtimeErrors.map(e => ({
      source: e.source,
      severity: e.severity,
      message: e.message,
      blocking: e.blocking,
    }));
  }

  if (result.auditWarnings && result.auditWarnings.length > 0) {
    evidence.auditWarnings = result.auditWarnings.map(w => ({
      name: w.name,
      severity: w.severity,
      title: w.title,
      url: w.url,
      fixAvailable: w.fixAvailable,
    }));
  }

  const filePath = join(tasksDir, `${taskId}-VERIFY.json`);
  writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
}

// ─── Pre-Execution Evidence ──────────────────────────────────────────────────

export interface PreExecutionEvidenceJSON {
  schemaVersion: 1;
  milestoneId: string;
  sliceId: string;
  timestamp: number;
  status: "pass" | "warn" | "fail";
  durationMs: number;
  checks: PreExecutionCheckJSON[];
}

/**
 * Write pre-execution check results to a PRE-EXEC-VERIFY.json artifact
 * in the slice directory.
 */
export function writePreExecutionEvidence(
  result: { status: "pass" | "warn" | "fail"; checks: PreExecutionCheckJSON[]; durationMs: number },
  sliceDir: string,
  milestoneId: string,
  sliceId: string,
): void {
  mkdirSync(sliceDir, { recursive: true });

  const evidence: PreExecutionEvidenceJSON = {
    schemaVersion: 1,
    milestoneId,
    sliceId,
    timestamp: Date.now(),
    status: result.status,
    durationMs: result.durationMs,
    checks: result.checks,
  };

  const filePath = join(sliceDir, `${sliceId}-PRE-EXEC-VERIFY.json`);
  writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
}

// ─── Markdown Evidence Table ─────────────────────────────────────────────────

/**
 * Format duration in milliseconds as seconds with 1 decimal place.
 * e.g. 2340 → "2.3s", 150 → "0.2s", 0 → "0.0s"
 *
 * Distinct from the shared formatDuration (which uses adaptive ms/s/m/h units);
 * evidence tables always display seconds for consistent column alignment.
 */
function formatDurationSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Generate a markdown evidence table from a VerificationResult.
 *
 * Returns a "no checks" note if result.checks is empty.
 * Otherwise returns a 5-column markdown table: #, Command, Exit Code, Verdict, Duration.
 */
export function formatEvidenceTable(result: VerificationResult): string {
  if (result.checks.length === 0) {
    return "_No verification checks discovered._";
  }

  const lines: string[] = [
    "| # | Command | Exit Code | Verdict | Duration |",
    "|---|---------|-----------|---------|----------|",
  ];

  for (let i = 0; i < result.checks.length; i++) {
    const check = result.checks[i];
    const num = i + 1;
    const verdict =
      check.exitCode === 0 ? "✅ pass" : "❌ fail";
    const duration = formatDurationSecs(check.durationMs);

    lines.push(
      `| ${num} | ${check.command} | ${check.exitCode} | ${verdict} | ${duration} |`,
    );
  }

  if (result.runtimeErrors && result.runtimeErrors.length > 0) {
    lines.push("");
    lines.push("**Runtime Errors**");
    lines.push("");
    lines.push("| # | Source | Severity | Blocking | Message |");
    lines.push("|---|--------|----------|----------|---------|");
    for (let i = 0; i < result.runtimeErrors.length; i++) {
      const err = result.runtimeErrors[i];
      const blockIcon = err.blocking ? "🚫 yes" : "ℹ️ no";
      lines.push(`| ${i + 1} | ${err.source} | ${err.severity} | ${blockIcon} | ${err.message.slice(0, 100)} |`);
    }
  }

  if (result.auditWarnings && result.auditWarnings.length > 0) {
    const severityEmoji: Record<string, string> = {
      critical: "🔴",
      high: "🟠",
      moderate: "🟡",
      low: "⚪",
    };
    lines.push("");
    lines.push("**Audit Warnings**");
    lines.push("");
    lines.push("| # | Package | Severity | Title | Fix Available |");
    lines.push("|---|---------|----------|-------|---------------|");
    for (let i = 0; i < result.auditWarnings.length; i++) {
      const w = result.auditWarnings[i];
      const emoji = severityEmoji[w.severity] ?? "⚪";
      const fix = w.fixAvailable ? "✅ yes" : "❌ no";
      lines.push(`| ${i + 1} | ${w.name} | ${emoji} ${w.severity} | ${w.title} | ${fix} |`);
    }
  }

  return lines.join("\n");
}
