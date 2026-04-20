/**
 * Apply user-configured security overrides from global settings.json and env vars.
 *
 * Both overrides are global-only (not project-level) because the threat model is
 * malicious project-level config in cloned repos. Global settings and env vars
 * represent the user's own authority on their machine.
 *
 * Precedence: env var > settings.json > built-in defaults
 */

import { type SettingsManager, setAllowedCommandPrefixes } from '@gsd/pi-coding-agent'
import { setFetchAllowedUrls } from './resources/extensions/search-the-web/url-utils.js'

export function applySecurityOverrides(settingsManager: SettingsManager): void {
  // --- Command prefix allowlist ---
  const envPrefixes = process.env.GSD_ALLOWED_COMMAND_PREFIXES
  if (envPrefixes) {
    const prefixes = envPrefixes.split(',').map(s => s.trim()).filter(Boolean)
    if (prefixes.length > 0) {
      setAllowedCommandPrefixes(prefixes)
    }
  } else {
    const settingsPrefixes = settingsManager.getAllowedCommandPrefixes()
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
    const settingsUrls = settingsManager.getFetchAllowedUrls()
    if (settingsUrls && settingsUrls.length > 0) {
      setFetchAllowedUrls(settingsUrls)
    }
  }
}
