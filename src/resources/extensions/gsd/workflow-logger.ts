// GSD Extension — Workflow Logger
// Centralized warning/error accumulator for the workflow engine pipeline.
// Captures structured entries that the auto-loop can drain after each unit
// to surface root causes for stuck loops, silent degradation, and blocked writes.
// Error-severity entries are persisted to .gsd/audit-log.jsonl (sanitized) for
// post-mortem analysis. Warnings are ephemeral (stderr + buffer only) to avoid
// log amplification from expected-control-flow catch paths.
//
// Stderr policy: every logWarning/logError call writes immediately to stderr
// for terminal visibility. This is intentional — unlike debug-logger (which is
// opt-in and zero-overhead when disabled), workflow-logger covers operational
// warnings/errors that should always be visible. There is no disable flag.
//
// Singleton safety: _buffer is module-level and shared across all calls within
// a process. The auto-loop must call _resetLogs() (or drainAndSummarize()) at
// the start of each unit to prevent log bleed between units running in the same
// Node process.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { appendNotification } from "./notification-store.js";

// ─── Types ──────────────────────────────────────────────────────────────

export type LogSeverity = "warn" | "error";

export type LogComponent =
  | "engine"        // WorkflowEngine afterCommand side effects
  | "projection"    // Projection rendering
  | "manifest"      // Manifest write
  | "event-log"     // Event append
  | "intercept"     // Write intercept / tool-call blocks
  | "migration"     // Auto-migration from markdown
  | "state"         // deriveState fallback/degradation
  | "tool"          // Tool handler errors
  | "compaction"    // Event compaction
  | "reconcile"     // Worktree reconciliation
  | "db"            // Database operations (gsd-db)
  | "dispatch"      // Auto-dispatch rule evaluation
  | "recovery"      // Auto-recovery and timeout recovery
  | "session"       // Session lock and session state I/O
  | "prompt"        // Prompt construction and context injection
  | "dashboard"     // Auto-dashboard rendering
  | "timer"         // Auto-timers (idle watchdog, hard timeout)
  | "worktree"      // Worktree lifecycle (create, sync, merge)
  | "command"       // Slash command execution and maintenance
  | "parallel"      // Parallel orchestrator and merge
  | "fs"            // Safe filesystem operations
  | "bootstrap"     // Extension bootstrap (system-context, agent-end)
  | "guided"        // Guided flow (discuss, plan wizards)
  | "registry"      // Rule registry hook state
  | "renderer"      // Markdown renderer and projections
  | "safety";       // LLM safety harness

export interface LogEntry {
  ts: string;
  severity: LogSeverity;
  component: LogComponent;
  message: string;
  /** Optional structured context (file path, command name, etc.) */
  context?: Record<string, string>;
}

// ─── Buffer & Persistent Audit ──────────────────────────────────────────

const MAX_BUFFER = 100;
let _buffer: LogEntry[] = [];
let _auditBasePath: string | null = null;
let _stderrEnabled = true;

/**
 * Set the base path for persistent audit log writes.
 * Should be called once at engine init with the project root.
 * Until set, log entries are buffered in-memory only.
 */
export function setLogBasePath(basePath: string): void {
  _auditBasePath = basePath;
}

/**
 * Enable or disable immediate stderr writes for workflow logs.
 * Returns the previous setting so callers can restore it.
 */
export function setStderrLoggingEnabled(enabled: boolean): boolean {
  const previous = _stderrEnabled;
  _stderrEnabled = enabled;
  return previous;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Record a warning. Also writes to stderr for terminal visibility.
 */
export function logWarning(
  component: LogComponent,
  message: string,
  context?: Record<string, string>,
): void {
  _push("warn", component, message, context);
}

/**
 * Record an error. Also writes to stderr for terminal visibility.
 */
export function logError(
  component: LogComponent,
  message: string,
  context?: Record<string, string>,
): void {
  _push("error", component, message, context);
}

/**
 * Drain all accumulated entries and clear the buffer.
 * Returns entries oldest-first.
 *
 * WARNING: Call summarizeLogs() or drainAndSummarize() BEFORE calling this
 * if you need a summary — drainLogs() clears the buffer immediately.
 */
export function drainLogs(): LogEntry[] {
  const entries = _buffer;
  _buffer = [];
  return entries;
}

/**
 * Atomically summarize then drain — the safe way to consume logs.
 * Use this in the auto-loop instead of calling summarizeLogs() + drainLogs()
 * separately to avoid the ordering footgun.
 */
export function drainAndSummarize(): { logs: LogEntry[]; summary: string | null } {
  const summary = summarizeLogs();
  const logs = drainLogs();
  return { logs, summary };
}

/**
 * Peek at current entries without clearing.
 */
export function peekLogs(): readonly LogEntry[] {
  return _buffer;
}

/**
 * Returns true if the buffer contains any error-severity entries.
 */
export function hasErrors(): boolean {
  return _buffer.some((e) => e.severity === "error");
}

/**
 * Returns true if the buffer contains any warn-severity entries.
 * Use hasAnyIssues() if you want to check for either severity.
 */
export function hasWarnings(): boolean {
  return _buffer.some((e) => e.severity === "warn");
}

/**
 * Returns true if the buffer contains any entries (warn or error).
 */
export function hasAnyIssues(): boolean {
  return _buffer.length > 0;
}

/**
 * Get a one-line summary of accumulated issues for stuck detection messages.
 * Returns null if no entries.
 *
 * Must be called BEFORE drainLogs() — use drainAndSummarize() for safe ordering.
 */
export function summarizeLogs(): string | null {
  if (_buffer.length === 0) return null;
  const errors = _buffer.filter((e) => e.severity === "error");
  const warns = _buffer.filter((e) => e.severity === "warn");

  const parts: string[] = [];
  if (errors.length > 0) {
    parts.push(`${errors.length} error(s): ${errors.map((e) => e.message).join("; ")}`);
  }
  if (warns.length > 0) {
    parts.push(`${warns.length} warning(s): ${warns.map((e) => e.message).join("; ")}`);
  }
  return parts.join(" | ");
}

/**
 * Format entries for display (used by auto-loop post-unit notification).
 * Includes key context fields (file paths, commands) when present.
 */
export function formatForNotification(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => {
    let line = `[${e.component}] ${e.message}`;
    if (e.context) {
      const ctxParts = Object.entries(e.context)
        .filter(([k]) => k !== "error") // error is redundant with message
        .map(([k, v]) => v.includes(",") ? `${k}: "${v}"` : `${k}: ${v}`);
      if (ctxParts.length > 0) {
        line += ` (${ctxParts.join(", ")})`;
      }
    }
    return line;
  }).join("\n");
}

/**
 * Read all entries from the persistent audit log.
 * Returns empty array if no basePath is set or the file doesn't exist.
 */
export function readAuditLog(basePath?: string): LogEntry[] {
  const bp = basePath ?? _auditBasePath;
  if (!bp) return [];
  const auditPath = join(bp, ".gsd", "audit-log.jsonl");
  if (!existsSync(auditPath)) return [];
  try {
    const content = readFileSync(auditPath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try { return JSON.parse(l) as LogEntry; } catch { return null; }
      })
      .filter((e): e is LogEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Reset buffer. Call at the start of each auto-loop unit to prevent log bleed
 * between units running in the same process. Also used in tests via _resetLogs().
 */
export function _resetLogs(): void {
  _buffer = [];
}

// ─── Internal ───────────────────────────────────────────────────────────

function _push(
  severity: LogSeverity,
  component: LogComponent,
  message: string,
  context?: Record<string, string>,
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    severity,
    component,
    message,
    ...(context ? { context } : {}),
  };

  // Always forward to stderr so terminal watchers see it (see module header for policy)
  const prefix = severity === "error" ? "ERROR" : "WARN";
  const ctxStr = context ? ` ${JSON.stringify(context)}` : "";
  _writeStderr(`[gsd:${component}] ${prefix}: ${message}${ctxStr}\n`);

  // Persist to notification store (both warnings and errors)
  try {
    appendNotification(
      `[${component}] ${message}`,
      severity === "error" ? "error" : "warning",
      "workflow-logger",
    );
  } catch (notifErr) {
    _writeStderr(`[gsd:workflow-logger] notification-store append failed: ${(notifErr as Error).message}\n`);
  }

  // Buffer for auto-loop to drain
  _buffer.push(entry);
  if (_buffer.length > MAX_BUFFER) {
    _buffer.shift();
  }

  // Persist errors to .gsd/audit-log.jsonl so they survive context resets.
  // Only error-severity entries are persisted — warnings are ephemeral (stderr + buffer)
  // to avoid log amplification from expected-control-flow catch paths.
  if (_auditBasePath && severity === "error") {
    try {
      const auditDir = join(_auditBasePath, ".gsd");
      mkdirSync(auditDir, { recursive: true });
      const sanitized = _sanitizeForAudit(entry);
      appendFileSync(join(auditDir, "audit-log.jsonl"), JSON.stringify(sanitized) + "\n", "utf-8");
    } catch (auditErr) {
      // Best-effort — never let audit write failures bubble up
      _writeStderr(`[gsd:audit] failed to persist log entry: ${(auditErr as Error).message}\n`);
    }
  }
}

function _writeStderr(message: string): void {
  if (!_stderrEnabled) return;
  process.stderr.write(message);
}

/**
 * Sanitize a log entry before persisting to the audit JSONL file.
 * Strips potentially sensitive context (raw paths, cwd, full error text)
 * to avoid leaking local environment details into durable telemetry.
 */
function _sanitizeForAudit(entry: LogEntry): LogEntry {
  const sanitized: LogEntry = {
    ts: entry.ts,
    severity: entry.severity,
    component: entry.component,
    // Truncate message to avoid persisting oversized raw error dumps
    message: entry.message.length > 200 ? entry.message.slice(0, 200) + "…[truncated]" : entry.message,
  };
  if (entry.context) {
    // Allowlist: only persist known-safe structured keys
    const SAFE_KEYS = new Set(["fn", "tool", "mid", "sid", "tid", "worktree", "id", "error", "count"]);
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.context)) {
      if (SAFE_KEYS.has(k)) {
        filtered[k] = v;
      }
    }
    if (Object.keys(filtered).length > 0) {
      sanitized.context = filtered;
    }
  }
  return sanitized;
}
