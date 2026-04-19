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
 * Check if the `claude` binary is installed (regardless of auth state).
 */
export function isClaudeBinaryInstalled(): boolean {
  try {
    execFileSync(CLAUDE_COMMAND, ['--version'], { timeout: 5_000, stdio: 'pipe' })
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
    execFileSync(CLAUDE_COMMAND, ['--version'], { timeout: 5_000, stdio: 'pipe' })
  } catch {
    return false
  }

  try {
    const output = execFileSync(CLAUDE_COMMAND, ['auth', 'status'], { timeout: 5_000, stdio: 'pipe' })
      .toString()
      .toLowerCase()
    return !(/not logged in|no credentials|unauthenticated|not authenticated/i.test(output))
  } catch {
    return false
  }
}
