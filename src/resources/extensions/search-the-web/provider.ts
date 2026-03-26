/**
 * Search provider selection and preference management.
 *
 * Single source of truth for which search backend (Tavily vs Brave) to use.
 * Reads API keys from process.env at call time (not module load time) so
 * hot-reloaded keys work. Preference is stored in auth.json under the
 * synthetic provider key `search_provider` as { type: "api_key", key: "tavily" | "brave" | "auto" }.
 *
 * @see S01-RESEARCH.md for the storage decision rationale (D002).
 */

import { AuthStorage } from '@gsd/pi-coding-agent'
import { homedir } from 'os'
import { join } from 'path'
import { resolveSearchProviderFromPreferences } from '../gsd/preferences.js'

// Compute authFilePath locally instead of importing from app-paths.ts,
// because extensions are copied to ~/.gsd/agent/extensions/ at runtime
// where the relative import '../../../app-paths.ts' doesn't resolve.
const gsdHome = process.env.GSD_HOME || join(homedir(), '.gsd')
const authFilePath = join(gsdHome, 'agent', 'auth.json')

export type SearchProvider = 'tavily' | 'brave' | 'ollama'
export type SearchProviderPreference = SearchProvider | 'auto'

const VALID_PREFERENCES = new Set<string>(['tavily', 'brave', 'ollama', 'auto'])
const PREFERENCE_KEY = 'search_provider'

/** Returns the Tavily API key from the environment, or empty string if not set. */
export function getTavilyApiKey(): string {
  return process.env.TAVILY_API_KEY || ''
}

/** Returns the Brave API key from the environment, or empty string if not set. */
export function getBraveApiKey(): string {
  return process.env.BRAVE_API_KEY || ''
}

/** Standard headers for Brave Search API requests. */
export function braveHeaders(): Record<string, string> {
  return {
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "X-Subscription-Token": getBraveApiKey(),
  }
}

/** Returns the Ollama API key from the environment, or empty string if not set. */
export function getOllamaApiKey(): string {
  return process.env.OLLAMA_API_KEY || ''
}

/**
 * Read the user's search provider preference from auth.json.
 * Returns 'auto' if no preference is stored or the stored value is invalid.
 *
 * @param authPath — Override auth.json path (for testing).
 */
export function getSearchProviderPreference(authPath?: string): SearchProviderPreference {
  const auth = AuthStorage.create(authPath ?? authFilePath)
  const cred = auth.get(PREFERENCE_KEY)
  if (cred?.type === 'api_key' && typeof cred.key === 'string' && VALID_PREFERENCES.has(cred.key)) {
    return cred.key as SearchProviderPreference
  }
  return 'auto'
}

/**
 * Write the user's search provider preference to auth.json.
 * Uses AuthStorage to go through file locking.
 *
 * @param pref — The preference to store.
 * @param authPath — Override auth.json path (for testing).
 */
export function setSearchProviderPreference(pref: SearchProviderPreference, authPath?: string): void {
  const auth = AuthStorage.create(authPath ?? authFilePath)
  auth.remove(PREFERENCE_KEY)
  auth.set(PREFERENCE_KEY, { type: 'api_key', key: pref })
}

/**
 * Resolve which search provider to use based on available API keys and user preference.
 *
 * Logic:
 * 1. If an explicit override is given, use it — but only if that provider's key exists.
 *    If the key doesn't exist, fall through to the other provider.
 * 2. Otherwise, read the stored preference.
 * 3. If preference is 'auto': prefer Tavily, then Brave.
 * 4. If preference is a specific provider: use it if key exists, else fall back to the other.
 * 5. Return null if neither key is available — explicit signal for "no provider".
 *
 * @param overridePreference — Optional override (e.g. from a tool parameter).
 */
export function resolveSearchProvider(overridePreference?: string): SearchProvider | null {
  const tavilyKey = getTavilyApiKey()
  const braveKey = getBraveApiKey()
  const ollamaKey = getOllamaApiKey()

  const hasTavily = tavilyKey.length > 0
  const hasBrave = braveKey.length > 0
  const hasOllama = ollamaKey.length > 0

  // Determine effective preference
  let pref: SearchProviderPreference
  if (overridePreference && VALID_PREFERENCES.has(overridePreference)) {
    pref = overridePreference as SearchProviderPreference
  } else {
    // PREFERENCES.md takes priority over auth.json
    const mdPref = resolveSearchProviderFromPreferences()
    if (mdPref && mdPref !== 'auto' && mdPref !== 'native') {
      pref = mdPref as SearchProviderPreference
    } else if (overridePreference !== undefined && !VALID_PREFERENCES.has(overridePreference)) {
      pref = 'auto'
    } else {
      pref = getSearchProviderPreference()
    }
  }

  // Resolve based on preference
  if (pref === 'auto') {
    if (hasTavily) return 'tavily'
    if (hasBrave) return 'brave'
    if (hasOllama) return 'ollama'
    return null
  }

  if (pref === 'tavily') {
    if (hasTavily) return 'tavily'
    if (hasBrave) return 'brave'
    if (hasOllama) return 'ollama'
    return null
  }

  if (pref === 'brave') {
    if (hasBrave) return 'brave'
    if (hasTavily) return 'tavily'
    if (hasOllama) return 'ollama'
    return null
  }

  if (pref === 'ollama') {
    if (hasOllama) return 'ollama'
    if (hasTavily) return 'tavily'
    if (hasBrave) return 'brave'
    return null
  }

  return null
}
