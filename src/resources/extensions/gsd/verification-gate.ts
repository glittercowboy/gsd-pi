// GSD Extension — Verification Gate
// Pure functions for discovering and running verification commands.
// Discovery order (D003): preference → task plan verify → package.json scripts.
// First non-empty source wins.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { AuditWarning, RuntimeError, VerificationCheck, VerificationResult } from "./types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";

/** Maximum bytes of stdout/stderr to retain per command (10 KB). */
const MAX_OUTPUT_BYTES = 10 * 1024;

/** Truncate a string to maxBytes, appending a marker if truncated. */
function truncate(value: string | null | undefined, maxBytes: number): string {
  if (!value) return "";
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  // Slice conservatively then trim to last full character
  const buf = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return buf.toString("utf-8") + "\n…[truncated]";
}

// ─── Command Discovery ──────────────────────────────────────────────────────

export interface DiscoverCommandsOptions {
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  cwd: string;
}

export interface DiscoveredCommands {
  commands: string[];
  source: VerificationResult["discoverySource"];
}

/** Package.json script keys to probe, in order. */
const PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"] as const;

/**
 * Discover verification commands using the first-non-empty-wins strategy (D003):
 *   1. Explicit preference commands
 *   2. Task plan verify field (split on &&)
 *   3. package.json scripts (typecheck, lint, test)
 *   4. None found
 */
export function discoverCommands(options: DiscoverCommandsOptions): DiscoveredCommands {
  // 1. Preference commands
  if (options.preferenceCommands && options.preferenceCommands.length > 0) {
    const filtered = options.preferenceCommands
      .map(c => c.trim())
      .filter(Boolean);
    if (filtered.length > 0) {
      return { commands: filtered, source: "preference" };
    }
  }

  // 2. Task plan verify field (commands are untrusted — sanitize)
  if (options.taskPlanVerify && options.taskPlanVerify.trim()) {
    const commands = options.taskPlanVerify
      .split("&&")
      .map(c => c.trim())
      .filter(Boolean)
      .filter(c => sanitizeCommand(c) !== null);
    if (commands.length > 0) {
      return { commands, source: "task-plan" };
    }
  }

  // 3. package.json scripts
  const pkgPath = join(options.cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const commands: string[] = [];
        for (const key of PACKAGE_SCRIPT_KEYS) {
          if (typeof pkg.scripts[key] === "string") {
            commands.push(`npm run ${key}`);
          }
        }
        if (commands.length > 0) {
          return { commands, source: "package-json" };
        }
      }
    } catch {
      // Malformed package.json — fall through to "none"
    }
  }

  // 4. Nothing found
  return { commands: [], source: "none" };
}

// ─── Failure Context Formatting ──────────────────────────────────────────────

/** Maximum chars of stderr to include per failed check in failure context. */
const MAX_STDERR_PER_CHECK = 2_000;

/** Maximum total chars for the combined failure context output. */
const MAX_FAILURE_CONTEXT_CHARS = 10_000;

/**
 * Format failed verification checks into a prompt-injectable text block.
 *
 * Each failed check gets a heading with the command name and exit code,
 * followed by a truncated stderr excerpt. Individual stderr is capped to
 * 2 000 chars; total output is capped to 10 000 chars.
 *
 * Returns an empty string when all checks pass or the checks array is empty.
 */
export function formatFailureContext(result: VerificationResult): string {
  const failures = result.checks.filter((c) => c.exitCode !== 0);
  if (failures.length === 0) return "";

  const blocks: string[] = [];

  for (const check of failures) {
    let stderr = check.stderr ?? "";
    if (stderr.length > MAX_STDERR_PER_CHECK) {
      stderr = stderr.slice(0, MAX_STDERR_PER_CHECK) + "\n…[truncated]";
    }

    blocks.push(
      `### ❌ \`${check.command}\` (exit code ${check.exitCode})\n\`\`\`stderr\n${stderr}\n\`\`\``,
    );
  }

  let body = blocks.join("\n\n");
  const header = "## Verification Failures\n\n";

  if (header.length + body.length > MAX_FAILURE_CONTEXT_CHARS) {
    body =
      body.slice(0, MAX_FAILURE_CONTEXT_CHARS - header.length) +
      "\n\n…[remaining failures truncated]";
  }

  return header + body;
}

// ─── Gate Execution ─────────────────────────────────────────────────────────

/** Characters that indicate shell injection when found in a command string. */
const SHELL_INJECTION_PATTERN = /[;|`]|\$\(/;

/**
 * Known executable first-tokens that are safe to run.
 * Lowercase commands, common build/test tools, and npm/yarn/pnpm invocations.
 */
const KNOWN_COMMAND_PREFIXES = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "bunx", "deno",
  "node", "ts-node", "tsx", "tsc",
  "sh", "bash", "zsh",
  "echo", "cat", "ls", "test", "true", "false", "pwd", "env",
  "make", "cargo", "go", "python", "python3", "pip", "pip3",
  "ruby", "gem", "bundle", "rake",
  "java", "javac", "mvn", "gradle",
  "docker", "docker-compose",
  "git", "gh",
  "eslint", "prettier", "vitest", "jest", "mocha", "pytest", "phpunit",
  "curl", "wget",
  "grep", "find", "diff", "wc", "sort", "head", "tail",
]);

/**
 * Heuristic check: does this string look like an executable shell command
 * rather than a prose description?
 *
 * Returns true when the string appears to be a command. Returns false
 * for English prose (e.g. "Document exists, contains all 5 scale names").
 *
 * Heuristics (any true → command-like):
 *   1. First token is a known command prefix
 *   2. First token starts with `.` or `/` (path-like)
 *   3. Any token starts with `-` (flag-like)
 *   4. First token contains no uppercase letters (commands are lowercase)
 *      AND first token does not end with a comma or colon (prose punctuation)
 *
 * Heuristics (any true → prose-like):
 *   1. First token starts with an uppercase letter and the string has 4+ words
 *   2. String contains commas followed by spaces (prose clause structure)
 */
export function isLikelyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];

  // Known command prefix → definitely a command
  if (KNOWN_COMMAND_PREFIXES.has(firstToken)) return true;

  // Path-like first token → command
  if (firstToken.startsWith("/") || firstToken.startsWith("./") || firstToken.startsWith("../")) return true;

  // Has flag-like tokens → command
  if (tokens.some(t => t.startsWith("-"))) return true;

  // First token starts with uppercase + 4 or more words → prose
  if (/^[A-Z]/.test(firstToken) && tokens.length >= 4) return false;

  // Contains comma-space patterns (prose clause separators) → prose
  if (/,\s/.test(trimmed) && tokens.length >= 4) return false;

  // First token has uppercase letters and no path separators → prose
  if (/[A-Z]/.test(firstToken) && !firstToken.includes("/")) return false;

  return true;
}

/**
 * Validate a command string for obvious shell injection patterns.
 * Returns the command unchanged if safe, or null if suspicious.
 */
function sanitizeCommand(cmd: string): string | null {
  if (SHELL_INJECTION_PATTERN.test(cmd)) return null;
  if (!isLikelyCommand(cmd)) return null;
  return cmd;
}

export interface RunVerificationGateOptions {
  cwd: string;
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Per-command timeout in ms. Defaults to 120 000 (2 minutes). */
  commandTimeoutMs?: number;
}

/**
 * Run the verification gate: discover commands, execute each via spawnSync,
 * and return a structured result.
 *
 * - All commands run sequentially regardless of individual pass/fail.
 * - `passed` is true when every command exits 0 (or no commands are discovered).
 * - stdout/stderr per command are truncated to 10 KB.
 */
export function runVerificationGate(options: RunVerificationGateOptions): VerificationResult {
  const timestamp = Date.now();

  const { commands, source } = discoverCommands({
    preferenceCommands: options.preferenceCommands,
    taskPlanVerify: options.taskPlanVerify,
    cwd: options.cwd,
  });

  if (commands.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: source,
      timestamp,
    };
  }

  const checks: VerificationCheck[] = [];

  for (const command of commands) {
    const start = Date.now();
    const rewrittenCommand = rewriteCommandWithRtk(command);
    // Pass the command string as an argument to the shell explicitly
    // to avoid Node.js DEP0190 (spawnSync with shell: true and no args).
    const shellBin = process.platform === "win32" ? "cmd" : "sh";
    const shellArgs = process.platform === "win32" ? ["/c", rewrittenCommand] : ["-c", rewrittenCommand];
    const result: SpawnSyncReturns<string> = spawnSync(shellBin, shellArgs, {
      cwd: options.cwd,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    const durationMs = Date.now() - start;

    let exitCode: number;
    let stderr: string;

    if (result.error) {
      // Command not found or spawn failure
      exitCode = 127;
      stderr = truncate(
        (result.stderr || "") + "\n" + (result.error as Error).message,
        MAX_OUTPUT_BYTES,
      );
    } else {
      // status is null when killed by signal — treat as failure
      exitCode = result.status ?? 1;
      stderr = truncate(result.stderr, MAX_OUTPUT_BYTES);
    }

    checks.push({
      command,
      exitCode,
      stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
      stderr,
      durationMs,
    });
  }

  return {
    passed: checks.every(c => c.exitCode === 0),
    checks,
    discoverySource: source,
    timestamp,
  };
}

// ─── Runtime Error Capture ──────────────────────────────────────────────────

/** Maximum characters of browser console text to retain per entry. */
const MAX_BROWSER_TEXT_CHARS = 500;

/** Fatal signals that indicate a crash regardless of other status fields. */
const FATAL_SIGNALS = new Set(["SIGABRT", "SIGSEGV", "SIGBUS"]);

/**
 * Injectable dependencies for captureRuntimeErrors.
 * When omitted the function uses dynamic import() to access
 * bg-shell's processes Map and browser-tools' getConsoleLogs().
 * Provide overrides in tests to avoid module mocking.
 */
export interface CaptureRuntimeErrorsOptions {
  getProcesses?: () => Map<string, unknown>;
  getConsoleLogs?: () => Array<{ type: string; text: string; timestamp: number; url: string }>;
}

/**
 * Scan bg-shell processes and browser console logs for runtime errors.
 *
 * Severity classification follows D004:
 *   - bg-shell status "crashed" → blocking crash
 *   - bg-shell !alive && exitCode !== 0 && exitCode !== null → blocking crash
 *   - bg-shell signal SIGABRT/SIGSEGV/SIGBUS → blocking crash
 *   - Browser console error with "Unhandled"/"UnhandledRejection" → blocking crash
 *   - Browser console error (general) → non-blocking error
 *   - Browser console warning with deprecation text → non-blocking warning
 *   - bg-shell alive process with recentErrors → non-blocking error
 *
 * Returns RuntimeError[] — empty when both sources are unavailable.
 */
export async function captureRuntimeErrors(
  options?: CaptureRuntimeErrorsOptions,
): Promise<RuntimeError[]> {
  const errors: RuntimeError[] = [];

  // ── bg-shell scan ─────────────────────────────────────────────────────
  try {
    let processes: Map<string, unknown>;
    if (options?.getProcesses) {
      processes = options.getProcesses();
    } else {
      const mod = await import("../bg-shell/process-manager.js");
      processes = mod.processes;
    }

    for (const [id, raw] of processes) {
      const proc = raw as {
        id: string;
        label?: string;
        status?: string;
        alive?: boolean;
        exitCode?: number | null;
        signal?: string | null;
        recentErrors?: string[];
      };

      const name = proc.label || proc.id || id;

      // Check for fatal signal first (applies regardless of alive/status)
      if (proc.signal && FATAL_SIGNALS.has(proc.signal)) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Crashed status
      if (proc.status === "crashed") {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Non-zero exit on dead process
      if (
        !proc.alive &&
        proc.exitCode !== 0 &&
        proc.exitCode !== null &&
        proc.exitCode !== undefined
      ) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Alive process with recent errors — non-blocking
      if (proc.alive && proc.recentErrors && proc.recentErrors.length > 0) {
        const snippet = proc.recentErrors.slice(0, 3).join("; ");
        errors.push({
          source: "bg-shell",
          severity: "error",
          message: `[${name}] recent errors: ${snippet}`,
          blocking: false,
        });
      }
    }
  } catch {
    // bg-shell not available — skip silently
  }

  // ── browser console scan ──────────────────────────────────────────────
  try {
    let logs: Array<{ type: string; text: string; timestamp: number; url: string }>;
    if (options?.getConsoleLogs) {
      logs = options.getConsoleLogs();
    } else {
      const mod = await import("../browser-tools/state.js");
      logs = mod.getConsoleLogs();
    }

    for (const entry of logs) {
      const text =
        entry.text.length > MAX_BROWSER_TEXT_CHARS
          ? entry.text.slice(0, MAX_BROWSER_TEXT_CHARS) + "…[truncated]"
          : entry.text;

      if (entry.type === "error") {
        // Unhandled rejection / unhandled error → blocking crash
        if (/unhandled/i.test(entry.text)) {
          errors.push({
            source: "browser",
            severity: "crash",
            message: text,
            blocking: true,
          });
        } else {
          // General console.error → non-blocking error
          errors.push({
            source: "browser",
            severity: "error",
            message: text,
            blocking: false,
          });
        }
      } else if (entry.type === "warning" && /deprecated/i.test(entry.text)) {
        // Deprecation warning → non-blocking warning
        errors.push({
          source: "browser",
          severity: "warning",
          message: text,
          blocking: false,
        });
      }
      // Non-deprecation warnings are intentionally ignored
    }
  } catch {
    // browser-tools not available — skip silently
  }

  return errors;
}

/** Build a human-readable message for a bg-shell process error. */
function buildBgShellMessage(
  name: string,
  exitCode: number | null | undefined,
  signal: string | null | undefined,
  recentErrors: string[] | undefined,
): string {
  const parts: string[] = [`[${name}]`];
  if (signal) parts.push(`signal=${signal}`);
  if (exitCode !== null && exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  if (recentErrors && recentErrors.length > 0) {
    const snippet = recentErrors.slice(0, 3).join("; ");
    parts.push(`errors: ${snippet}`);
  }
  return parts.join(" ");
}

// ─── Dependency Audit ───────────────────────────────────────────────────────

/** Top-level dependency files that trigger an audit when changed. */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

/**
 * Injectable dependencies for runDependencyAudit (D023 pattern).
 * When omitted the function uses real git/npm via spawnSync.
 * Provide overrides in tests to avoid real git repos and npm registries.
 */
export interface DependencyAuditOptions {
  gitDiff?: (cwd: string) => string[];
  npmAudit?: (cwd: string) => { stdout: string; exitCode: number };
}

/**
 * Default gitDiff: runs `git diff --name-only HEAD` and returns file paths.
 * Returns empty array on any failure (non-git dir, git not found, etc.).
 */
function defaultGitDiff(cwd: string): string[] {
  try {
    const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Default npmAudit: runs `npm audit --audit-level=moderate --json`.
 * Returns { stdout, exitCode }. Non-zero exit is expected when vulnerabilities exist.
 */
function defaultNpmAudit(cwd: string): { stdout: string; exitCode: number } {
  const result = spawnSync("npm", ["audit", "--audit-level=moderate", "--json"], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? "",
    exitCode: result.status ?? 1,
  };
}

/**
 * Detect dependency file changes and run npm audit if changes are found.
 *
 * - Calls gitDiff to get changed files, checks if any are top-level dependency files
 * - If no dependency files changed, returns []
 * - Runs npmAudit and parses JSON output into AuditWarning[]
 * - Never throws — all errors return []
 * - Non-zero npm audit exit code is expected (vulnerabilities found), not an error
 */
export function runDependencyAudit(
  cwd: string,
  options?: DependencyAuditOptions,
): AuditWarning[] {
  try {
    const gitDiff = options?.gitDiff ?? defaultGitDiff;
    const npmAudit = options?.npmAudit ?? defaultNpmAudit;

    // Get changed files and check for top-level dependency file matches
    const changedFiles = gitDiff(cwd);
    const hasDependencyChange = changedFiles.some((filePath) => {
      const name = basename(filePath);
      // Only match top-level files: the path must equal just the filename
      // (no directory separators) to be considered top-level
      return DEPENDENCY_FILES.has(name) && filePath === name;
    });

    if (!hasDependencyChange) return [];

    // Run npm audit
    const auditResult = npmAudit(cwd);

    // Parse JSON output — npm audit exits non-zero when vulnerabilities exist
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(auditResult.stdout);
    } catch {
      return [];
    }

    // Extract vulnerabilities from the parsed output
    const vulnerabilities = parsed.vulnerabilities;
    if (!vulnerabilities || typeof vulnerabilities !== "object") return [];

    const warnings: AuditWarning[] = [];
    for (const [name, raw] of Object.entries(vulnerabilities as Record<string, unknown>)) {
      const vuln = raw as {
        severity?: string;
        fixAvailable?: boolean;
        via?: unknown[];
      };
      if (!vuln || typeof vuln !== "object") continue;

      const severity = vuln.severity;
      if (
        severity !== "low" &&
        severity !== "moderate" &&
        severity !== "high" &&
        severity !== "critical"
      ) {
        continue;
      }

      // Find the first `via` entry that's an object (not a string reference)
      let title = name;
      let url = "";
      if (Array.isArray(vuln.via)) {
        for (const entry of vuln.via) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const obj = entry as { title?: string; url?: string };
            if (obj.title) title = obj.title;
            if (obj.url) url = obj.url;
            break;
          }
        }
      }

      warnings.push({
        name,
        severity: severity as AuditWarning["severity"],
        title,
        url,
        fixAvailable: vuln.fixAvailable === true,
      });
    }

    return warnings;
  } catch {
    return [];
  }
}
