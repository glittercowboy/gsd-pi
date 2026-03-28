import { randomBytes } from 'node:crypto'
import { exec, execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appRoot, webPidFilePath as defaultWebPidFilePath, webPreferencesPath as defaultWebPreferencesPath, webAuthPath as defaultWebAuthPath } from './app-paths.js'

// src/web/ is excluded from tsc compilation (runs with Node.js type-stripping).
// Resolve from project root (one level up from dist/ or src/) to always find src/web/.
const _projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const _webSessionAuthPath = join(_projectRoot, 'src', 'web', 'web-session-auth.ts')
const _tailscalePath = join(_projectRoot, 'src', 'web', 'tailscale.ts')

type TailscaleInfo = { hostname: string; tailnet: string; fqdn: string; url: string }
class TailscaleServeError extends Error { exitCode: number; stderr: string; constructor(msg: string, exitCode: number, stderr: string) { super(msg); this.exitCode = exitCode; this.stderr = stderr } }

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Open a URL in the user's default browser. */
function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    // PowerShell's Start-Process handles URLs with '&' safely; cmd /c start does not.
    execFile('powershell', ['-c', `Start-Process '${url.replace(/'/g, "''")}'`], () => {})
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}

type WritableLike = Pick<typeof process.stderr, 'write'>

type ResourceBootstrapLike = {
  initResources: (agentDir: string) => void
}

type SpawnedChildLike = Pick<ChildProcess, 'once' | 'unref' | 'pid'>

export interface WebModeLaunchOptions {
  cwd: string
  projectSessionsDir: string
  agentDir: string
  packageRoot?: string
  host?: string
  port?: number
  /** Additional allowed origins for CORS (forwarded as GSD_WEB_ALLOWED_ORIGINS). */
  allowedOrigins?: string[]
  /** Activate Tailscale Serve mode: `--tailscale` */
  tailscale?: boolean
}

export interface ResolvedWebHostBootstrap {
  ok: true
  kind: 'packaged-standalone' | 'source-dev'
  packageRoot: string
  hostRoot: string
  entryPath: string
}

export interface UnresolvedWebHostBootstrap {
  ok: false
  packageRoot: string
  reason: string
  candidates: string[]
}

export type WebHostBootstrap = ResolvedWebHostBootstrap | UnresolvedWebHostBootstrap

export interface WebModeLaunchSuccess {
  mode: 'web'
  ok: true
  cwd: string
  projectSessionsDir: string
  host: string
  port: number
  url: string
  hostKind: ResolvedWebHostBootstrap['kind']
  hostPath: string
  hostRoot: string
}

export interface WebModeLaunchFailure {
  mode: 'web'
  ok: false
  cwd: string
  projectSessionsDir: string
  host: string
  port: number | null
  url: string | null
  hostKind: ResolvedWebHostBootstrap['kind'] | 'unresolved'
  hostPath: string | null
  hostRoot: string | null
  failureReason: string
  candidates?: string[]
}

export type WebModeLaunchStatus = WebModeLaunchSuccess | WebModeLaunchFailure

export interface WebModeDeps {
  existsSync?: (path: string) => boolean
  initResources?: (agentDir: string) => void
  resolvePort?: (host: string) => Promise<number>
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChildLike
  waitForBootReady?: (url: string) => Promise<void>
  openBrowser?: (url: string) => void
  stderr?: WritableLike
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execPath?: string
  pidFilePath?: string
  writePidFile?: (path: string, pid: number) => void
  readPidFile?: (path: string) => number | null
  deletePidFile?: (path: string) => void
  /** Path to the multi-instance registry JSON (for testing). */
  registryPath?: string
  /** Tailscale wrapper functions (for testing) */
  isTailscaleInstalled?: () => boolean
  getTailscaleStatus?: () => import('./web/tailscale.js').TailscaleStatusResult
  startTailscaleServe?: (port: number) => Promise<void>
  stopTailscaleServe?: (options?: { strict?: boolean }) => Promise<void>
  stopTailscaleServeSync?: () => void
  readPasswordHash?: () => string | null
}

export interface WebModeStopResult {
  ok: boolean
  reason?: string
  /** How many instances were stopped (relevant for --all) */
  stoppedCount?: number
}

// ─── Instance Registry ──────────────────────────────────────────────────────

export interface WebInstanceEntry {
  pid: number
  port: number
  url: string
  cwd: string
  startedAt: string
  /** Tailscale URL when instance was started with --tailscale */
  tailscaleUrl?: string
}

export type WebInstanceRegistry = Record<string, WebInstanceEntry>

const WEB_INSTANCES_PATH = join(appRoot, 'web-instances.json')

export function readInstanceRegistry(registryPath = WEB_INSTANCES_PATH): WebInstanceRegistry {
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8')) as WebInstanceRegistry
  } catch {
    return {}
  }
}

export function writeInstanceRegistry(registry: WebInstanceRegistry, registryPath = WEB_INSTANCES_PATH): void {
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8')
}

export function registerInstance(cwd: string, entry: Omit<WebInstanceEntry, 'cwd' | 'startedAt'>, registryPath = WEB_INSTANCES_PATH): void {
  const registry = readInstanceRegistry(registryPath)
  registry[resolve(cwd)] = {
    ...entry,
    cwd: resolve(cwd),
    startedAt: new Date().toISOString(),
  }
  writeInstanceRegistry(registry, registryPath)
}

export function unregisterInstance(cwd: string, registryPath = WEB_INSTANCES_PATH): void {
  const registry = readInstanceRegistry(registryPath)
  delete registry[resolve(cwd)]
  writeInstanceRegistry(registry, registryPath)
}

function killPid(pid: number): 'killed' | 'already-dead' | { error: string } {
  try {
    process.kill(pid, 'SIGTERM')
    return 'killed'
  } catch (error) {
    const isAlreadyDead = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
    if (isAlreadyDead) return 'already-dead'
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function writePidFile(filePath: string, pid: number): void {
  writeFileSync(filePath, String(pid), 'utf8')
}

export function readPidFile(filePath: string): number | null {
  try {
    const content = readFileSync(filePath, 'utf8').trim()
    const pid = parseInt(content, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function deletePidFile(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // Non-fatal — file may already be gone
  }
}

export interface WebModeStopOptions {
  /** Stop instance for a specific project path */
  projectCwd?: string
  /** Stop all running instances */
  all?: boolean
}

export function stopWebMode(deps: Pick<WebModeDeps, 'pidFilePath' | 'readPidFile' | 'deletePidFile' | 'stderr'> = {}, options: WebModeStopOptions = {}): WebModeStopResult {
  const stderr = deps.stderr ?? process.stderr

  // ── Stop all instances ──────────────────────────────────────────────
  if (options.all) {
    const registry = readInstanceRegistry()
    const entries = Object.entries(registry)
    if (entries.length === 0) {
      // Fall back to legacy PID file
      return stopLegacyPidFile(deps)
    }
    let stopped = 0
    for (const [cwd, entry] of entries) {
      const result = killPid(entry.pid)
      if (result === 'killed') {
        stderr.write(`[gsd] Stopped web server for ${cwd} (pid=${entry.pid})\n`)
        stopped++
      } else if (result === 'already-dead') {
        stderr.write(`[gsd] Web server for ${cwd} was already stopped (pid=${entry.pid})\n`)
        stopped++
      } else {
        stderr.write(`[gsd] Failed to stop web server for ${cwd}: ${result.error}\n`)
      }
      unregisterInstance(cwd)
    }
    // Also clean up legacy PID file
    const deletePid = deps.deletePidFile ?? deletePidFile
    const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath
    deletePid(pidFilePath)
    stderr.write(`[gsd] Stopped ${stopped} instance${stopped === 1 ? '' : 's'}.\n`)
    return { ok: true, stoppedCount: stopped }
  }

  // ── Stop specific project ──────────────────────────────────────────
  if (options.projectCwd) {
    const resolvedCwd = resolve(options.projectCwd)
    const registry = readInstanceRegistry()
    const entry = registry[resolvedCwd]
    if (!entry) {
      stderr.write(`[gsd] No web server running for ${resolvedCwd}\n`)
      return { ok: false, reason: 'not-found' }
    }
    const result = killPid(entry.pid)
    unregisterInstance(resolvedCwd)
    if (result === 'killed') {
      stderr.write(`[gsd] Stopped web server for ${resolvedCwd} (pid=${entry.pid})\n`)
      return { ok: true, stoppedCount: 1 }
    } else if (result === 'already-dead') {
      stderr.write(`[gsd] Web server for ${resolvedCwd} was already stopped — cleared stale entry.\n`)
      return { ok: true, stoppedCount: 1 }
    } else {
      stderr.write(`[gsd] Failed to stop web server for ${resolvedCwd}: ${result.error}\n`)
      return { ok: false, reason: result.error }
    }
  }

  // ── Default: stop via legacy PID file (backward compat) ─────────────
  return stopLegacyPidFile(deps)
}

function stopLegacyPidFile(deps: Pick<WebModeDeps, 'pidFilePath' | 'readPidFile' | 'deletePidFile' | 'stderr'>): WebModeStopResult {
  const stderr = deps.stderr ?? process.stderr
  const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath
  const readPid = deps.readPidFile ?? readPidFile
  const deletePid = deps.deletePidFile ?? deletePidFile

  const pid = readPid(pidFilePath)
  if (pid === null) {
    stderr.write(`[gsd] Web server is not running (no PID file found)\n`)
    return { ok: false, reason: 'no-pid-file' }
  }

  stderr.write(`[gsd] Stopping web server (pid=${pid})…\n`)

  const result = killPid(pid)
  deletePid(pidFilePath)
  if (result === 'killed') {
    stderr.write(`[gsd] Web server stopped.\n`)
    return { ok: true }
  } else if (result === 'already-dead') {
    stderr.write(`[gsd] Web server was already stopped — cleared stale PID file.\n`)
    return { ok: true }
  } else {
    stderr.write(`[gsd] Failed to stop web server: ${result.error}\n`)
    return { ok: false, reason: result.error }
  }
}

async function loadResourceBootstrap(): Promise<ResourceBootstrapLike> {
  const mod = await import('./resource-loader.js')
  return {
    initResources: mod.initResources,
  }
}

export function resolveWebHostBootstrap(options: {
  packageRoot?: string
  existsSync?: (path: string) => boolean
} = {}): WebHostBootstrap {
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT
  const checkExists = options.existsSync ?? existsSync
  const packagedStandaloneServer = join(packageRoot, 'dist', 'web', 'standalone', 'server.js')
  if (checkExists(packagedStandaloneServer)) {
    return {
      ok: true,
      kind: 'packaged-standalone',
      packageRoot,
      hostRoot: join(packageRoot, 'dist', 'web', 'standalone'),
      entryPath: packagedStandaloneServer,
    }
  }

  const sourceWebRoot = join(packageRoot, 'web')
  const sourceManifest = join(sourceWebRoot, 'package.json')
  if (checkExists(sourceManifest)) {
    return {
      ok: true,
      kind: 'source-dev',
      packageRoot,
      hostRoot: sourceWebRoot,
      entryPath: sourceManifest,
    }
  }

  return {
    ok: false,
    packageRoot,
    reason: 'host bootstrap not found',
    candidates: [packagedStandaloneServer, sourceManifest],
  }
}

export async function reserveWebPort(host = DEFAULT_HOST): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to determine reserved web port')))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(address.port)
      })
    })
  })
}

function getSpawnCommandForSourceHost(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

function formatLaunchStatus(status: WebModeLaunchStatus): string {
  if (status.ok) {
    return `[gsd] Web mode startup: status=started cwd=${status.cwd} port=${status.port} host=${status.hostPath} kind=${status.hostKind} url=${status.url}\n`
  }

  return `[gsd] Web mode startup: status=failed cwd=${status.cwd} port=${status.port ?? 'n/a'} host=${status.hostPath ?? 'unresolved'} kind=${status.hostKind} reason=${status.failureReason}\n`
}

function emitLaunchStatus(stderr: WritableLike, status: WebModeLaunchStatus): void {
  stderr.write(formatLaunchStatus(status))
}

function buildSpawnSpec(
  resolution: ResolvedWebHostBootstrap,
  host: string,
  port: number,
  platform: NodeJS.Platform,
  execPath: string,
): { command: string; args: string[]; cwd: string } {
  if (resolution.kind === 'packaged-standalone') {
    return {
      command: execPath,
      args: [resolution.entryPath],
      cwd: resolution.hostRoot,
    }
  }

  return {
    command: getSpawnCommandForSourceHost(platform),
    args: ['run', 'dev', '--', '--hostname', host, '--port', String(port)],
    cwd: resolution.hostRoot,
  }
}

async function spawnDetachedProcess(
  spawnCommand: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChildLike,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<{ ok: true; child: SpawnedChildLike } | { ok: false; error: unknown }> {
  return await new Promise((resolve) => {
    try {
      const child = spawnCommand(command, args, options)
      let settled = false
      const finish = (result: { ok: true; child: SpawnedChildLike } | { ok: false; error: unknown }) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      child.once?.('error', (error) => finish({ ok: false, error }))
      setImmediate(() => finish({ ok: true, child }))
    } catch (error) {
      resolve({ ok: false, error })
    }
  })
}

async function requestLocalJson(url: string, timeoutMs: number, authToken?: string): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // Keep launch readiness on the cheapest uncompressed path. The
      // packaged host can spend noticeable time compressing the large boot
      // snapshot, which adds avoidable startup jitter for a local health
      // check that only needs the JSON payload itself.
      'Accept-Encoding': 'identity',
    }
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`
    }
    const request = httpRequest(
      url,
      {
        method: 'GET',
        headers,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve({ statusCode, body }))
      },
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`))
    })
    request.once('error', reject)
    request.end()
  })
}

async function waitForBootReady(url: string, timeoutMs = 180_000, stderr?: WritableLike, authToken?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let lastError: string | null = null
  let lastBody: string | null = null
  let hostUp = false
  let consecutive5xx = 0
  const MAX_CONSECUTIVE_5XX = 3
  // Print a progress dot every N ms while waiting so the terminal isn't silent
  const TICKER_INTERVAL_MS = 5_000
  let lastTickAt = startedAt

  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`

  while (Date.now() < deadline) {
    try {
      // Give the packaged host enough time to finish a cold /api/boot render.
      const response = await requestLocalJson(`${url}/api/boot`, 45_000, authToken)

      if (response.statusCode >= 200 && response.statusCode < 300) {
        if (!hostUp) {
          hostUp = true
          stderr?.write(`[gsd] Web host ready.\n`)
        }
        consecutive5xx = 0
        // Host responded successfully — it's ready for the browser
        return
      } else if (response.statusCode >= 500) {
        consecutive5xx++
        lastError = `http ${response.statusCode}`
        lastBody = response.body || null
        if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
          const detail = lastBody ? `: ${lastBody.slice(0, 500)}` : ''
          throw new Error(
            `boot route returned ${MAX_CONSECUTIVE_5XX} consecutive 5xx responses (last: ${response.statusCode})${detail}`,
          )
        }
      } else {
        consecutive5xx = 0
        lastError = `http ${response.statusCode}`
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('boot route returned')) {
        throw error
      }
      // Connection refused, timeout, etc. — transient during cold start
      consecutive5xx = 0
      lastError = error instanceof Error ? error.message : String(error)
    }

    // Emit a heartbeat line every TICKER_INTERVAL_MS to show we're alive
    const now = Date.now()
    if (now - lastTickAt >= TICKER_INTERVAL_MS) {
      lastTickAt = now
      if (hostUp) {
        stderr?.write(`[gsd] Still waiting… (${elapsed()})\n`)
      } else {
        stderr?.write(`[gsd] Waiting for web host… (${elapsed()})\n`)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(lastError ?? 'timed out waiting for boot readiness')
}

/**
 * If a previous web server instance is registered for the same `cwd`, attempt
 * to kill it and remove its registry entry so the new launch can bind the port
 * cleanly.  This handles the "orphan process" scenario where a prior `gsd --web`
 * was terminated without clean shutdown (e.g. terminal closed).
 */
function cleanupStaleInstance(cwd: string, stderr: WritableLike, registryPath?: string): void {
  const registry = readInstanceRegistry(registryPath)
  const key = resolve(cwd)
  const stale = registry[key]
  if (!stale) return

  stderr.write(`[gsd] Cleaning up stale web server for ${key} (pid=${stale.pid}, port=${stale.port})…\n`)
  const result = killPid(stale.pid)
  if (result === 'killed') {
    stderr.write(`[gsd] Killed stale web server (pid=${stale.pid}).\n`)
  } else if (result === 'already-dead') {
    stderr.write(`[gsd] Stale web server was already stopped (pid=${stale.pid}) — clearing entry.\n`)
  } else {
    stderr.write(`[gsd] Could not kill stale web server (pid=${stale.pid}): ${result.error}\n`)
  }
  unregisterInstance(cwd, registryPath)
}

// ─── Tailscale helpers ───────────────────────────────────────────────────────

function readPasswordHashFromPrefs(prefsPath = defaultWebAuthPath): string | null {
  try {
    const data = JSON.parse(readFileSync(prefsPath, 'utf-8')) as Record<string, unknown>
    return typeof data.passwordHash === 'string' && data.passwordHash.length > 0 ? data.passwordHash : null
  } catch {
    return null
  }
}

function findActiveTailscaleInstance(registryPath?: string): WebInstanceEntry | null {
  const registry = readInstanceRegistry(registryPath)
  for (const entry of Object.values(registry)) {
    if (!entry.tailscaleUrl) continue
    try {
      process.kill(entry.pid, 0) // signal 0 = existence check
      return entry
    } catch {
      // Process is dead — stale entry, ignore
    }
  }
  return null
}

export async function launchWebMode(
  options: WebModeLaunchOptions,
  deps: WebModeDeps = {},
): Promise<WebModeLaunchStatus> {
  const stderr = deps.stderr ?? process.stderr
  const host = options.host ?? DEFAULT_HOST
  const resolution = resolveWebHostBootstrap({
    packageRoot: options.packageRoot,
    existsSync: deps.existsSync,
  })

  if (!resolution.ok) {
    const failure: WebModeLaunchFailure = {
      mode: 'web',
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port: null,
      url: null,
      hostKind: 'unresolved',
      hostPath: null,
      hostRoot: null,
      failureReason: `${resolution.reason}; checked=${resolution.candidates.join(',')}`,
      candidates: resolution.candidates,
    }
    emitLaunchStatus(stderr, failure)
    return failure
  }

  stderr.write(`[gsd] Starting web mode…\n`)

  // Kill any stale server instance for this project before reserving a port.
  // This prevents EADDRINUSE when the previous `gsd --web` was terminated
  // without a clean shutdown (e.g. terminal closed, crash).
  cleanupStaleInstance(options.cwd, stderr, deps.registryPath)

  // -- Tailscale Serve lifecycle -----------------------------------------------
  let tailscaleInfo: TailscaleInfo | undefined
  let cleanupFired = false
  let tailscaleServeStop: ((options?: { strict?: boolean }) => Promise<void>) | undefined
  let tailscaleServeStopSync: (() => void) | undefined

  if (options.tailscale) {
    const _ts = await import(_tailscalePath)
    const checkInstalled = deps.isTailscaleInstalled ?? _ts.isTailscaleInstalled
    const checkStatus = deps.getTailscaleStatus ?? _ts.getTailscaleStatus
    const serveStop = deps.stopTailscaleServe ?? _ts.stopTailscaleServe
    const serveStopSync = deps.stopTailscaleServeSync ?? _ts.stopTailscaleServeSync
    const checkPassword = deps.readPasswordHash ?? readPasswordHashFromPrefs

    // Capture for cleanup handlers (defined after vars are assigned)
    tailscaleServeStop = serveStop
    tailscaleServeStopSync = serveStopSync

    // Singleton guard: Tailscale Serve binds port 443 globally — only one instance allowed
    const existing = findActiveTailscaleInstance(deps.registryPath)
    if (existing) {
      const failure: WebModeLaunchFailure = {
        mode: 'web', ok: false, cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host, port: null, url: null,
        hostKind: resolution.ok ? resolution.kind : 'unresolved',
        hostPath: resolution.ok ? resolution.entryPath : null,
        hostRoot: resolution.ok ? resolution.hostRoot : null,
        failureReason: 'tailscale:already-running',
      }
      stderr.write(`[gsd] Error: Tailscale Serve is already active (pid=${existing.pid}, url=${existing.tailscaleUrl}).\n`)
      stderr.write(`[gsd] Stop it first: gsd web stop --all\n`)
      emitLaunchStatus(stderr, failure)
      return failure
    }

    // Step 1: Preflight checks
    if (!checkInstalled()) {
      const installCmd = _ts.getInstallCommand(deps.platform ?? process.platform)
      const failure: WebModeLaunchFailure = {
        mode: 'web', ok: false, cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host, port: null, url: null,
        hostKind: resolution.ok ? resolution.kind : 'unresolved',
        hostPath: resolution.ok ? resolution.entryPath : null,
        hostRoot: resolution.ok ? resolution.hostRoot : null,
        failureReason: 'tailscale:cli-not-found',
      }
      stderr.write(`[gsd] Error: Tailscale CLI not found.\n`)
      stderr.write(`[gsd] Install it: ${installCmd}\n`)
      emitLaunchStatus(stderr, failure)
      return failure
    }

    const statusResult = checkStatus()
    if (!statusResult.ok) {
      let message = 'Unknown Tailscale error.'
      let hint = 'Check: tailscale status'
      switch (statusResult.reason) {
        case 'not-connected':
          message = 'Tailscale is not connected.'
          hint = 'Run: tailscale up'
          break
        case 'invalid-status':
          message = 'Tailscale status returned unexpected data.'
          hint = 'Check: tailscale status'
          break
        case 'cli-error':
          message = `Tailscale CLI error${statusResult.stderr ? `: ${statusResult.stderr}` : ''}.`
          hint = 'Check that tailscaled is running: tailscale status'
          break
      }
      const failure: WebModeLaunchFailure = {
        mode: 'web', ok: false, cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host, port: null, url: null,
        hostKind: resolution.ok ? resolution.kind : 'unresolved',
        hostPath: resolution.ok ? resolution.entryPath : null,
        hostRoot: resolution.ok ? resolution.hostRoot : null,
        failureReason: `tailscale:${statusResult.reason}`,
      }
      stderr.write(`[gsd] Error: ${message}\n`)
      stderr.write(`[gsd] ${hint}\n`)
      emitLaunchStatus(stderr, failure)
      return failure
    }
    tailscaleInfo = statusResult.info

    if (!checkPassword()) {
      const failure: WebModeLaunchFailure = {
        mode: 'web', ok: false, cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host, port: null, url: null,
        hostKind: resolution.ok ? resolution.kind : 'unresolved',
        hostPath: resolution.ok ? resolution.entryPath : null,
        hostRoot: resolution.ok ? resolution.hostRoot : null,
        failureReason: 'tailscale:no-password',
      }
      stderr.write(`[gsd] Error: Remote access requires a password.\n`)
      stderr.write(`[gsd] Set one in GSD settings or run: gsd settings\n`)
      emitLaunchStatus(stderr, failure)
      return failure
    }

    // Step 2: Register cleanup handlers early
    const asyncCleanup = async () => {
      if (cleanupFired) return
      cleanupFired = true
      try { await serveStop() } catch { /* best-effort */ }
      process.exit(0)
    }
    process.once('SIGINT', () => { asyncCleanup(); })
    process.once('SIGTERM', () => { asyncCleanup(); })
    process.once('exit', () => {
      if (!cleanupFired) {
        serveStopSync()
      }
    })

    // Step 3: Unconditional startup reset with strict: true
    try {
      await serveStop({ strict: true })
    } catch (error) {
      stderr.write(`[gsd] Warning: tailscale serve reset failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const port = options.port ?? await (deps.resolvePort ?? reserveWebPort)(host)
  const authToken = randomBytes(32).toString('hex')
  const url = `http://${host}:${port}`

  // Read or create session secret for cookie auth verification in proxy.ts (Edge Runtime)
  let sessionSecret = ''
  try {
    const _sessionAuth = await import(_webSessionAuthPath)
    sessionSecret = await _sessionAuth.getOrCreateSessionSecret()
  } catch {
    // Non-fatal — cookie auth will be disabled, bearer token auth still works
  }

  const env = {
    ...(deps.env ?? process.env),
    HOSTNAME: host,
    PORT: String(port),
    GSD_WEB_HOST: host,
    GSD_WEB_PORT: String(port),
    GSD_WEB_AUTH_TOKEN: authToken,
    GSD_WEB_SESSION_SECRET: sessionSecret,
    GSD_WEB_PROJECT_CWD: options.cwd,
    GSD_WEB_PROJECT_SESSIONS_DIR: options.projectSessionsDir,
    GSD_WEB_PACKAGE_ROOT: resolution.packageRoot,
    GSD_WEB_HOST_KIND: resolution.kind,
    ...(resolution.kind === 'source-dev' ? { NEXT_PUBLIC_GSD_DEV: '1' } : {}),
    ...(options.allowedOrigins?.length ? { GSD_WEB_ALLOWED_ORIGINS: options.allowedOrigins.join(',') } : {}),
  }

  // Tailscale: inject daemon mode + allowed origins
  if (options.tailscale && tailscaleInfo) {
    ;(env as Record<string, string>).GSD_WEB_DAEMON_MODE = '1'
    const existingOrigins = env.GSD_WEB_ALLOWED_ORIGINS
    env.GSD_WEB_ALLOWED_ORIGINS = existingOrigins
      ? `${existingOrigins},${tailscaleInfo.url}`
      : tailscaleInfo.url
  }

  try {
    stderr.write(`[gsd] Initialising resources…\n`)
    const bootstrap = deps.initResources ? { initResources: deps.initResources } : await loadResourceBootstrap()
    bootstrap.initResources(options.agentDir)
  } catch (error) {
    const failure: WebModeLaunchFailure = {
      mode: 'web',
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `bootstrap:${error instanceof Error ? error.message : String(error)}`,
    }
    emitLaunchStatus(stderr, failure)
    return failure
  }

  const spawnSpec = buildSpawnSpec(
    resolution,
    host,
    port,
    deps.platform ?? process.platform,
    deps.execPath ?? process.execPath,
  )

  stderr.write(`[gsd] Launching web host on port ${port}…\n`)

  const spawnResult = await spawnDetachedProcess(
    deps.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions)),
    spawnSpec.command,
    spawnSpec.args,
    {
      cwd: spawnSpec.cwd,
      detached: !options.tailscale, // attached in tailscale mode so parent stays alive
      stdio: options.tailscale ? 'inherit' : 'ignore', // pass through output in foreground mode
      env,
    },
  )

  if (!spawnResult.ok) {
    const failure: WebModeLaunchFailure = {
      mode: 'web',
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `launch:${spawnResult.error instanceof Error ? spawnResult.error.message : String(spawnResult.error)}`,
    }
    emitLaunchStatus(stderr, failure)
    return failure
  }

  try {
    const bootReadyFn = deps.waitForBootReady ?? ((u: string) => waitForBootReady(u, 180_000, stderr, authToken))
    await bootReadyFn(url)
  } catch (error) {
    const failure: WebModeLaunchFailure = {
      mode: 'web',
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `boot-ready:${error instanceof Error ? error.message : String(error)}`,
    }
    emitLaunchStatus(stderr, failure)
    return failure
  }

  // Step 7: Start Tailscale Serve after boot-ready
  if (options.tailscale && tailscaleInfo) {
    try {
      const _ts2 = await import(_tailscalePath)
      const serveStart = deps.startTailscaleServe ?? _ts2.startTailscaleServe
      await serveStart(port)
    } catch (error) {
      // Rollback: kill the spawned child, unregister, clean up
      const childPid = spawnResult.child.pid
      if (childPid !== undefined) {
        killPid(childPid)
        unregisterInstance(options.cwd, deps.registryPath)
        const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath
        ;(deps.deletePidFile ?? deletePidFile)(pidFilePath)
      }

      const stderrMsg = (error as any)?.stderr ?? ''
      const failure: WebModeLaunchFailure = {
        mode: 'web', ok: false, cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host, port, url,
        hostKind: resolution.kind,
        hostPath: resolution.entryPath,
        hostRoot: resolution.hostRoot,
        failureReason: `tailscale:serve-failed`,
      }
      stderr.write(`[gsd] Error: tailscale serve failed.\n`)
      if (stderrMsg) {
        stderr.write(`[gsd] tailscale stderr: ${stderrMsg}\n`)
      }
      stderr.write(`[gsd] Check: tailscale serve status\n`)
      emitLaunchStatus(stderr, failure)
      return failure
    }
  }

  try {
    if (!options.tailscale) {
      spawnResult.child.unref?.()
    }
    const pid = spawnResult.child.pid
    if (pid !== undefined) {
      const pidFilePath = deps.pidFilePath ?? defaultWebPidFilePath
      ;(deps.writePidFile ?? writePidFile)(pidFilePath, pid)
      // Register in multi-instance registry
      registerInstance(
        options.cwd,
        {
          pid,
          port,
          url,
          ...(options.tailscale && tailscaleInfo ? { tailscaleUrl: tailscaleInfo.url } : {}),
        },
        deps.registryPath,
      )
    }

    if (options.tailscale && tailscaleInfo) {
      // Tailscale mode: print remote URL, skip local browser
      stderr.write(`\nAccessible at: ${tailscaleInfo.url}\n\n`)
    } else {
      const authenticatedUrl = `${url}/#token=${authToken}`
      try {
        ;(deps.openBrowser ?? openBrowser)(authenticatedUrl)
      } catch (browserError) {
        stderr.write(`[gsd] Could not open browser: ${browserError instanceof Error ? browserError.message : String(browserError)}\n`)
      }
    }
  } catch (error) {
    const failure: WebModeLaunchFailure = {
      mode: 'web',
      ok: false,
      cwd: options.cwd,
      projectSessionsDir: options.projectSessionsDir,
      host,
      port,
      url,
      hostKind: resolution.kind,
      hostPath: resolution.entryPath,
      hostRoot: resolution.hostRoot,
      failureReason: `browser-open:${error instanceof Error ? error.message : String(error)}`,
    }
    emitLaunchStatus(stderr, failure)
    return failure
  }

  const authenticatedUrl = `${url}/#token=${authToken}`
  const success: WebModeLaunchSuccess = {
    mode: 'web',
    ok: true,
    cwd: options.cwd,
    projectSessionsDir: options.projectSessionsDir,
    host,
    port,
    url,
    hostKind: resolution.kind,
    hostPath: resolution.entryPath,
    hostRoot: resolution.hostRoot,
  }
  if (options.tailscale && tailscaleInfo) {
    stderr.write(`[gsd] Ready → ${tailscaleInfo.url}\n`)
  } else {
    stderr.write(`[gsd] Ready → ${authenticatedUrl}\n`)
  }
  emitLaunchStatus(stderr, success)

  // In Tailscale mode, keep the parent process alive so SIGINT/SIGTERM cleanup
  // handlers can fire and run `tailscale serve reset`. Without this, the parent
  // returns, the event loop drains, and the process exits — killing the child
  // and leaving orphaned Tailscale serve config.
  if (options.tailscale) {
    await new Promise<void>((resolve) => {
      spawnResult.child.once('exit', () => resolve())
      // Also resolve if parent receives SIGINT/SIGTERM (cleanup handlers already registered)
      process.once('SIGINT', () => resolve())
      process.once('SIGTERM', () => resolve())
    })
  }

  return success
}
