/**
 * Apply user-configured security overrides from global settings.json and env vars.
 *
 * Both overrides are global-only (not project-level) because the threat model is
 * malicious project-level config in cloned repos. Global settings and env vars
 * represent the user's own authority on their machine.
 *
 * Precedence: env var > settings.json > built-in defaults
 */

import type { SettingsManager } from '@gsd/pi-coding-agent'
import { setFetchAllowedUrls } from './resources/extensions/search-the-web/url-utils.js'

// ---------------------------------------------------------------------------
// GSD-owned command prefix allowlist state
// (setAllowedCommandPrefixes / getAllowedCommandPrefixes were removed from
//  pi-coding-agent's SettingsManager in 0.67.2 — GSD owns this state now)
// ---------------------------------------------------------------------------

export const SAFE_COMMAND_PREFIXES: readonly string[] = ['npm', 'npx', 'yarn', 'pnpm', 'node']

let _allowedCommandPrefixes: string[] = [...SAFE_COMMAND_PREFIXES]

export function setAllowedCommandPrefixes(prefixes: string[]): void {
  _allowedCommandPrefixes = prefixes
}

export function getAllowedCommandPrefixes(): readonly string[] {
  return _allowedCommandPrefixes
}

// Extension interface for removed SettingsManager methods — lets GSD call
// the methods when running against an older pi-coding-agent build that still
// has them, while compiling cleanly against 0.67.2 which removed them.
interface GSDSettingsManager extends SettingsManager {
  getAllowedCommandPrefixes?(): string[] | undefined
  getFetchAllowedUrls?(): string[] | undefined
}

export function applySecurityOverrides(settingsManager: SettingsManager): void {
  const sm = settingsManager as GSDSettingsManager

  // --- Command prefix allowlist ---
  const envPrefixes = process.env.GSD_ALLOWED_COMMAND_PREFIXES
  if (envPrefixes) {
    const prefixes = envPrefixes.split(',').map(s => s.trim()).filter(Boolean)
    if (prefixes.length > 0) {
      setAllowedCommandPrefixes(prefixes)
    }
  } else {
    const settingsPrefixes = sm.getAllowedCommandPrefixes?.()
    if (settingsPrefixes && settingsPrefixes.length > 0) {
      setAllowedCommandPrefixes(settingsPrefixes)
    }
  }

  // --- Fetch URL allowlist (SSRF exemptions) ---
  const envUrls = process.env.GSD_FETCH_ALLOWED_URLS
  if (envUrls) {
    const urls = envUrls.split(',').map(s => s.trim()).filter(Boolean)
    if (urls.length > 0) {
      setFetchAllowedUrls(urls)
    }
  } else {
    const settingsUrls = sm.getFetchAllowedUrls?.()
    if (settingsUrls && settingsUrls.length > 0) {
      setFetchAllowedUrls(settingsUrls)
    }
  }
}
