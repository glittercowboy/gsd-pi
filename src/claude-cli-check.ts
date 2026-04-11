// GSD2 — Claude CLI binary detection for onboarding
// Lightweight check used at onboarding time (before extensions load).
// The full readiness check with caching lives in the claude-code-cli extension.

import { execFileSync } from 'node:child_process'

/**
 * Check if the `claude` binary is installed (regardless of auth state).
 */
export function isClaudeBinaryInstalled(): boolean {
  try {
    execFileSync('claude', ['--version'], { timeout: 5_000, stdio: 'pipe' })
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
    execFileSync('claude', ['--version'], { timeout: 5_000, stdio: 'pipe' })
  } catch {
    return false
  }

  try {
    const output = execFileSync('claude', ['auth', 'status'], { timeout: 5_000, stdio: 'pipe' })
      .toString()
      .toLowerCase()
    return !(/not logged in|no credentials|unauthenticated|not authenticated/i.test(output))
  } catch {
    return false
  }
}
