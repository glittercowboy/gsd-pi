import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import { appRoot } from './app-paths.js'

const CACHE_FILE = join(appRoot, '.update-check')
const NPM_PACKAGE_NAME = 'gsd-pi'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 5000

interface UpdateCheckCache {
  lastCheck: number
  latestVersion: string
}

/**
 * Compares two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

export function readUpdateCache(cachePath: string = CACHE_FILE): UpdateCheckCache | null {
  try {
    if (!existsSync(cachePath)) return null
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch {
    return null
  }
}

export function writeUpdateCache(cache: UpdateCheckCache, cachePath: string = CACHE_FILE): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(cache))
  } catch {
    // Non-fatal — don't block startup if cache write fails
  }
}

function printUpdateBanner(current: string, latest: string): void {
  process.stderr.write(
    `  ${chalk.yellow('Update available:')} ${chalk.dim(`v${current}`)} → ${chalk.bold(`v${latest}`)}\n` +
    `  ${chalk.dim('Run')} npm update -g gsd-pi ${chalk.dim('or')} /gsd:update ${chalk.dim('to upgrade')}\n\n`,
  )
}

export interface UpdateCheckOptions {
  currentVersion?: string
  cachePath?: string
  registryUrl?: string
  checkIntervalMs?: number
  fetchTimeoutMs?: number
  onUpdate?: (current: string, latest: string) => void
}

/**
 * Non-blocking update check. Queries npm registry at most once per 24h,
 * caches the result, and prints a banner if a newer version is available.
 */
export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<void> {
  const currentVersion = options.currentVersion || process.env.GSD_VERSION || '0.0.0'
  const cachePath = options.cachePath || CACHE_FILE
  const registryUrl = options.registryUrl || `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
  const onUpdate = options.onUpdate || printUpdateBanner

  // Check cache — skip network if checked recently
  const cache = readUpdateCache(cachePath)
  if (cache && Date.now() - cache.lastCheck < checkIntervalMs) {
    if (compareSemver(cache.latestVersion, currentVersion) > 0) {
      onUpdate(currentVersion, cache.latestVersion)
    }
    return
  }

  // Fetch latest version from npm registry
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)

  try {
    const res = await fetch(registryUrl, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) return

    const data = (await res.json()) as { version?: string }
    const latestVersion = data.version
    if (!latestVersion) return

    writeUpdateCache({ lastCheck: Date.now(), latestVersion }, cachePath)

    if (compareSemver(latestVersion, currentVersion) > 0) {
      onUpdate(currentVersion, latestVersion)
    }
  } catch {
    // Network error or timeout — silently ignore, don't block startup
  } finally {
    clearTimeout(timeout)
  }
}
