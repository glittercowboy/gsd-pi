/**
 * Cross-platform Python interpreter resolver.
 *
 * Provides utilities to detect the available Python interpreter on the current
 * system and to normalize shell commands that reference `python`/`python3` so
 * that they use whichever interpreter is actually installed.
 *
 * On Windows the canonical names differ (`py -3`, `python`, `python3`), so
 * hard-coded `python3` invocations fail with exit 127. This module detects the
 * working interpreter once (cached for the process lifetime) and rewrites
 * commands accordingly.
 *
 * @module python-resolver
 */

import { spawnSync } from "node:child_process";

/** Cached result of `detectPythonExecutable`. `undefined` means not yet probed. */
let cached: string | null | undefined;

/**
 * Returns the first working Python invocation on this system, or `null` if no
 * Python interpreter is found.
 *
 * Probe order:
 * - Windows: `py -3` → `python` → `python3`
 * - All other platforms: `python3` → `python`
 *
 * The result is cached for the lifetime of the process to avoid repeated
 * `spawnSync` calls.
 */
export function detectPythonExecutable(): string | null {
  if (cached !== undefined) return cached;
  const candidates: string[] = process.platform === "win32"
    ? ["py -3", "python", "python3"]
    : ["python3", "python"];
  for (const candidate of candidates) {
    const [bin, ...args] = candidate.split(" ");
    const r = spawnSync(bin, [...args, "--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) {
      cached = candidate;
      return candidate;
    }
  }
  cached = null;
  return null;
}

/**
 * Rewrites a shell command string so that leading `python`/`python3`/`py`
 * tokens at command boundaries are replaced with the interpreter returned by
 * `detectPythonExecutable`.
 *
 * Only tokens at command boundaries (start of string, or after `&&`, `||`,
 * `;`) are rewritten — mid-string occurrences (e.g. file paths containing
 * "python") are left intact.
 *
 * When no Python interpreter is detected, the command is returned unchanged so
 * that the caller receives a meaningful "command not found" error rather than a
 * silent no-op.
 *
 * @param command - The shell command string to normalize.
 * @returns The command with Python interpreter tokens rewritten, or the
 *   original command if no rewrite is needed.
 */
export function normalizePythonCommand(command: string): string {
  const executable = detectPythonExecutable();
  if (!executable) return command;

  // Split on common shell separators to handle compound commands.
  // We reconstruct the string preserving the original separators.
  return command.replace(
    /(^\s*|(?:&&|\|\||;)\s*)(?:python3?|py(?:\s+-\d+)?)(?=\s|$)/g,
    (_match, pre: string) => `${pre}${executable}`,
  );
}
