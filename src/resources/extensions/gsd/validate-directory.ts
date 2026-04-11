/**
 * GSD Directory Validation — Safeguards against running in dangerous directories.
 *
 * Prevents GSD from creating .gsd/ structures in system paths, home directories,
 * or other locations where writing project scaffolding would be harmful.
 */

import { realpathSync, readdirSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { resolve } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface DirectoryValidationResult {
  /** Whether the directory is safe for GSD operations */
  safe: boolean;
  /** Severity: "blocked" = hard stop, "warning" = user can override */
  severity: "ok" | "blocked" | "warning";
  /** Human-readable reason if not safe */
  reason?: string;
}

// ─── Blocked Paths ──────────────────────────────────────────────────────────────

/** Paths where GSD must never create .gsd/ — no override possible. */
const UNIX_BLOCKED_PATHS = new Set([
  "/",
  "/bin",
  "/sbin",
  "/usr",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/local",
  "/usr/local/bin",
  "/etc",
  "/var",
  "/var/tmp",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/lib",
  "/lib64",
  // macOS-specific
  "/System",
  "/Library",
  "/Applications",
  "/Volumes",
  "/private",
  "/private/var",
  "/private/etc",
  "/private/tmp",
]);

const WINDOWS_BLOCKED_PATHS = new Set([
  "C:\\",
  "C:\\Windows",
  "C:\\Windows\\System32",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
]);

const WINDOWS_BLOCKED_SUFFIXES = new Set([
  "\\",
  "\\windows",
  "\\windows\\system32",
  "\\program files",
  "\\program files (x86)",
]);

function normalizePathForComparison(dirPath: string): string {
  let normalized = dirPath.replace(/[/\\]+$/, "");
  if (normalized === "") {
    normalized = "/";
  } else if (/^[A-Za-z]:$/.test(normalized)) {
    normalized += "\\";
  }
  return platform() === "win32" ? normalized.toLowerCase() : normalized;
}

function isBlockedWindowsPath(normalized: string): boolean {
  if (!/^[a-z]:\\/.test(normalized)) {
    return false;
  }

  const suffix = normalized.slice(2);
  return WINDOWS_BLOCKED_SUFFIXES.has(suffix);
}

// ─── Core Validation ────────────────────────────────────────────────────────────

/**
 * Validate whether a directory is safe for GSD to operate in.
 *
 * Checks in order:
 * 1. Blocked system paths (hard stop)
 * 2. Home directory itself (hard stop)
 * 3. Temp directory root (hard stop)
 * 4. High entry count heuristic (warning)
 */
export function validateDirectory(dirPath: string): DirectoryValidationResult {
  // Resolve to absolute + follow symlinks so aliases can't bypass checks
  let resolved: string;
  try {
    resolved = realpathSync(resolve(dirPath));
  } catch {
    // If we can't resolve, use the raw resolved path
    resolved = resolve(dirPath);
  }

  // Normalize trailing slashes for consistent comparison.
  // Special cases: "/" → "/" (not ""), "C:\" → "C:\" (not "C:")
  const normalized = normalizePathForComparison(resolved);

  // ── Check 1: Blocked system paths ──────────────────────────────────────
  const blockedPaths = platform() === "win32" ? WINDOWS_BLOCKED_PATHS : UNIX_BLOCKED_PATHS;
  if (platform() === "win32" ? isBlockedWindowsPath(normalized) : blockedPaths.has(normalized)) {
    return {
      safe: false,
      severity: "blocked",
      reason: `Refusing to run in system directory: ${normalized}. GSD must be run inside a project directory.`,
    };
  }

  // ── Check 2: Home directory itself (not subdirs) ───────────────────────
  let resolvedHome: string;
  try {
    resolvedHome = normalizePathForComparison(realpathSync(resolve(homedir())));
  } catch {
    resolvedHome = normalizePathForComparison(resolve(homedir()));
  }

  if (normalized === resolvedHome) {
    return {
      safe: false,
      severity: "blocked",
      reason: `Refusing to run in your home directory (${normalized}). GSD must be run inside a project directory, not $HOME.`,
    };
  }

  // ── Check 3: Temp directory root ───────────────────────────────────────
  let resolvedTmp: string;
  try {
    resolvedTmp = normalizePathForComparison(realpathSync(resolve(tmpdir())));
  } catch {
    resolvedTmp = normalizePathForComparison(resolve(tmpdir()));
  }

  if (normalized === resolvedTmp) {
    return {
      safe: false,
      severity: "blocked",
      reason: `Refusing to run in the system temp directory (${normalized}). Use a project subdirectory instead.`,
    };
  }

  // ── Check 4: Suspiciously large directory (heuristic warning) ──────────
  try {
    const entries = readdirSync(normalized);
    if (entries.length > 200) {
      return {
        safe: false,
        severity: "warning",
        reason: `This directory has ${entries.length} entries, which suggests it may not be a project directory. Are you sure you want to initialize GSD here?`,
      };
    }
  } catch {
    // Can't read directory — let downstream handle the error
  }

  return { safe: true, severity: "ok" };
}

/**
 * Assert that a directory is safe for GSD operations.
 * Throws with a descriptive message if the directory is blocked.
 * Returns the validation result for warnings (caller decides how to handle).
 */
export function assertSafeDirectory(dirPath: string): DirectoryValidationResult {
  const result = validateDirectory(dirPath);
  if (result.severity === "blocked") {
    throw new Error(result.reason);
  }
  return result;
}
