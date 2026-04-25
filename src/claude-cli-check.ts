// GSD2 — Claude CLI binary detection for onboarding
// Lightweight check used at onboarding time (before extensions load).
// The full readiness check with caching lives in the claude-code-cli extension.

import { execFileSync } from 'node:child_process'

/**
 * Platform-correct binary name for the Claude Code CLI.
 *
 * On Windows, npm-global binaries are installed as `.cmd` shims and
 * `execFileSync` does not auto-resolve the extension — calling bare
 * `claude` would fail with ENOENT even when the CLI is installed and
 * authenticated. Mirrors the `NPM_COMMAND` pattern in
 * `src/resources/extensions/gsd/pre-execution-checks.ts`.
 */
export const CLAUDE_COMMAND = process.platform === 'win32' ? 'claude.cmd' : 'claude'

/**
 * Ordered list of binary names to probe for the Claude Code CLI.
 *
 * Windows installs vary: npm-global installs produce a `claude.cmd` shim,
 * direct binary installs produce `claude.exe`, and Git Bash wrappers may
 * expose a bare `claude` shim. Try all three so no valid install is missed.
 */
const CLAUDE_COMMAND_CANDIDATES: string[] =
  process.platform === 'win32' ? [CLAUDE_COMMAND, 'claude.exe', 'claude'] : [CLAUDE_COMMAND]

/**
 * Try to run `args` against each candidate binary.
 * Returns the output buffer on first success, throws the last error if all fail.
 */
function execClaudeCheck(args: string[]): Buffer {
  let lastError: unknown
  for (const command of CLAUDE_COMMAND_CANDIDATES) {
    try {
      return execFileSync(command, args, {
        timeout: 5_000,
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      // EINVAL can surface on Windows Git Bash for .cmd spawn failures.
      if (code === 'ENOENT' || code === 'EINVAL') continue
      throw error
    }
  }
  throw lastError ?? new Error(`Claude CLI not found (tried: ${CLAUDE_COMMAND_CANDIDATES.join(', ')})`)
}

/**
 * Check if the `claude` binary is installed (regardless of auth state).
 */
export function isClaudeBinaryInstalled(): boolean {
  try {
    execClaudeCheck(['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Check if the `claude` CLI is installed AND authenticated.
 */
export function isClaudeCliReady(): boolean {
  try {
    execClaudeCheck(['--version'])
  } catch {
    return false
  }

  try {
    const output = execClaudeCheck(['auth', 'status'])
      .toString()
      .toLowerCase()
    return !(/not logged in|no credentials|unauthenticated|not authenticated/i.test(output))
  } catch {
    return false
  }
}
