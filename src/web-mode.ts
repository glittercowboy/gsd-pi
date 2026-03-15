import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrowser } from './onboarding.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type WritableLike = Pick<typeof process.stderr, 'write'>

type ResourceBootstrapLike = {
  initResources: (agentDir: string) => void
}

type SpawnedChildLike = Pick<ChildProcess, 'once' | 'unref'>

export interface WebModeLaunchOptions {
  cwd: string
  projectSessionsDir: string
  agentDir: string
  packageRoot?: string
  host?: string
  port?: number
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

async function waitForBootReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: string | null = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/boot`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })

      if (response.ok) {
        const payload = await response.json() as { bridge?: { phase?: string } }
        if (payload.bridge?.phase === 'ready') {
          return
        }
        lastError = `boot responded but bridge phase was ${payload.bridge?.phase ?? 'unknown'}`
      } else {
        lastError = `boot responded with ${response.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(lastError ?? 'timed out waiting for boot readiness')
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

  const port = options.port ?? await (deps.resolvePort ?? reserveWebPort)(host)
  const url = `http://${host}:${port}`
  const env = {
    ...(deps.env ?? process.env),
    HOSTNAME: host,
    PORT: String(port),
    GSD_WEB_HOST: host,
    GSD_WEB_PORT: String(port),
    GSD_WEB_PROJECT_CWD: options.cwd,
    GSD_WEB_PROJECT_SESSIONS_DIR: options.projectSessionsDir,
    GSD_WEB_PACKAGE_ROOT: resolution.packageRoot,
    GSD_WEB_HOST_KIND: resolution.kind,
  }

  try {
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

  const spawnResult = await spawnDetachedProcess(
    deps.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions)),
    spawnSpec.command,
    spawnSpec.args,
    {
      cwd: spawnSpec.cwd,
      detached: true,
      stdio: 'ignore',
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
    await (deps.waitForBootReady ?? waitForBootReady)(url)
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

  try {
    spawnResult.child.unref?.()
    ;(deps.openBrowser ?? openBrowser)(url)
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
  emitLaunchStatus(stderr, success)
  return success
}
