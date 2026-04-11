import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import { appRoot } from './app-paths.js'
import { execSync } from 'node:child_process'

const CACHE_FILE = join(appRoot, '.update-check')
const NPM_PACKAGE_NAME = 'gsd-pi'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 5000
const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`

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

function normalizeLatestVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null
  const trimmed = version.trim().replace(/^v/, '')
  return trimmed.length > 0 ? trimmed : null
}

export async function fetchLatestVersionFromRegistry(
  registryUrl: string = DEFAULT_REGISTRY_URL,
  fetchTimeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)

  try {
    const res = await fetch(registryUrl, { signal: controller.signal })
    if (!res.ok) return null

    const data = (await res.json()) as { version?: string }
    return normalizeLatestVersion(data.version)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function printUpdateBanner(current: string, latest: string): void {
  process.stderr.write(
    `  ${chalk.yellow('Update available:')} ${chalk.dim(`v${current}`)} → ${chalk.bold(`v${latest}`)}\n` +
    `  ${chalk.dim('Run')} npm update -g gsd-pi ${chalk.dim('or')} /gsd update ${chalk.dim('to upgrade')}\n\n`,
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
  const registryUrl = options.registryUrl || DEFAULT_REGISTRY_URL
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

  try {
    const latestVersion = await fetchLatestVersionFromRegistry(registryUrl, fetchTimeoutMs)
    if (!latestVersion) return

    writeUpdateCache({ lastCheck: Date.now(), latestVersion }, cachePath)

    if (compareSemver(latestVersion, currentVersion) > 0) {
      onUpdate(currentVersion, latestVersion)
    }
  } catch {
    // Network error or timeout — silently ignore, don't block startup
  }
}

const PROMPT_TIMEOUT_MS = 30_000

/**
 * Interactive update prompt shown at startup when a newer version is available.
 * Fetches the latest version (with cache), then asks the user whether to
 * update now or skip. Runs at most once per 24 hours (same cache as checkForUpdates).
 * Defaults to skip after 30 seconds of inactivity.
 *
 * Returns true if an update was performed, false otherwise.
 */
export async function checkAndPromptForUpdates(options: UpdateCheckOptions = {}): Promise<boolean> {
  const currentVersion = options.currentVersion || process.env.GSD_VERSION || '0.0.0'
  const cachePath = options.cachePath || CACHE_FILE
  const registryUrl = options.registryUrl || DEFAULT_REGISTRY_URL
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS

  // Determine latest version (from cache or network)
  let latestVersion: string | null = null

  const cache = readUpdateCache(cachePath)
  if (cache && Date.now() - cache.lastCheck < checkIntervalMs) {
    latestVersion = cache.latestVersion
  } else {
    try {
      latestVersion = await fetchLatestVersionFromRegistry(registryUrl, fetchTimeoutMs)
      if (latestVersion) {
        writeUpdateCache({ lastCheck: Date.now(), latestVersion }, cachePath)
      }
    } catch {
      // Network unavailable — silently skip
    }
  }

  if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) {
    return false
  }

  // Update available — show interactive prompt
  // Measure visible (ANSI-free) width to size the box, then render with chalk.
  const midContent = `  ${chalk.bold('Update available!')} ${chalk.dim(`v${currentVersion}`)} → ${chalk.bold.green(`v${latestVersion}`)}  `
  const midVisible = `  Update available! v${currentVersion} → v${latestVersion}  `
  const innerWidth = midVisible.length
  const top = '╔' + '═'.repeat(innerWidth) + '╗'
  const bot = '╚' + '═'.repeat(innerWidth) + '╝'

  process.stderr.write('\n')
  process.stderr.write(
    `  ${chalk.yellow(top)}\n` +
    `  ${chalk.yellow('║')}${midContent}${chalk.yellow('║')}\n` +
    `  ${chalk.yellow(bot)}\n\n`,
  )

  // Use readline for a simple two-option prompt that works without @clack/prompts
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

  const choice = await new Promise<string>((resolve) => {
    process.stderr.write(
      `  ${chalk.bold('[1]')} Update now   ${chalk.dim(`npm install -g ${NPM_PACKAGE_NAME}@latest`)}\n` +
      `  ${chalk.bold('[2]')} Skip\n\n`,
    )

    // Default to skip if the user doesn't respond within PROMPT_TIMEOUT_MS
    const timer = setTimeout(() => {
      process.stderr.write('\n')
      rl.close()
      resolve('2')
    }, PROMPT_TIMEOUT_MS)

    rl.question(`  ${chalk.bold('Choose [1/2]:')} `, (answer) => {
      clearTimeout(timer)
      resolve(answer.trim())
    })
  })

  rl.close()

  // Clean up stdin state so the TUI can start with a clean slate
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.setRawMode) process.stdin.setRawMode(false)
  process.stdin.pause()

  if (choice === '1') {
    process.stderr.write(`\n  ${chalk.dim('Running:')} npm install -g ${NPM_PACKAGE_NAME}@latest\n\n`)
    try {
      execSync(`npm install -g ${NPM_PACKAGE_NAME}@latest`, { stdio: 'inherit' })
      process.stderr.write(`\n  ${chalk.green.bold(`✓ Updated to v${latestVersion}`)}\n\n`)
      return true
    } catch {
      process.stderr.write(`\n  ${chalk.yellow(`Update failed. You can run: npm install -g ${NPM_PACKAGE_NAME}@latest`)}\n\n`)
    }
  } else {
    process.stderr.write(`  ${chalk.dim('Skipped. Run')} gsd update ${chalk.dim('anytime to upgrade.')}\n\n`)
  }

  return false
}
