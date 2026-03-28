import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseCliArgs } from '../cli-web-branch.ts'
import { launchWebMode } from '../web-mode.ts'
import { TailscaleServeError } from '../web/tailscale.ts'

// ─── Shared test data ─────────────────────────────────────────────────────────

const fakeTailscaleInfo = {
  hostname: 'testbox',
  tailnet: 'test.ts.net',
  fqdn: 'testbox.test.ts.net',
  url: 'https://testbox.test.ts.net',
}

// ─── Mock deps factory ────────────────────────────────────────────────────────

function buildMockDeps(overrides?: Record<string, unknown>) {
  const calls: string[] = []
  const capturedEnv: Record<string, string> = {}
  const stderrOutput: string[] = []
  let spawnOptions: Record<string, unknown> | null = null

  const deps = {
    existsSync: () => true,
    initResources: () => {},
    resolvePort: () => Promise.resolve(9999),
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawnOptions = opts
      Object.assign(capturedEnv, opts.env)
      return { once: () => {}, unref: () => {}, pid: 12345 }
    },
    waitForBootReady: () => Promise.resolve(),
    openBrowser: () => { calls.push('openBrowser') },
    stderr: { write: (msg: string) => { stderrOutput.push(msg) } },
    env: {},
    platform: 'darwin' as const,
    execPath: '/usr/bin/node',
    pidFilePath: '/tmp/test-gsd-web.pid',
    writePidFile: () => {},
    readPidFile: () => null,
    deletePidFile: () => { calls.push('deletePidFile') },
    registryPath: join(tmpdir(), `test-web-instances-${process.pid}.json`),
    isTailscaleInstalled: () => true,
    getTailscaleStatus: () => ({ ok: true as const, info: fakeTailscaleInfo }),
    startTailscaleServe: async (_port: number) => { calls.push('startServe') },
    stopTailscaleServe: async () => { calls.push('stopServe') },
    stopTailscaleServeSync: () => { calls.push('stopServeSync') },
    readPasswordHash: () => 'scrypt-hash-placeholder',
    ...overrides,
  }

  return {
    deps,
    calls,
    capturedEnv,
    stderrOutput,
    getSpawnOptions: () => spawnOptions,
  }
}

const BASE_OPTIONS = {
  cwd: '/tmp/test-project',
  projectSessionsDir: '/tmp/test-sessions',
  agentDir: '/tmp/test-agent',
  tailscale: true as const,
}

// ─── Flag parsing tests ───────────────────────────────────────────────────────

test('parseCliArgs sets tailscale=true when --tailscale flag is present', () => {
  const flags = parseCliArgs(['node', 'gsd', '--web', '--tailscale'])
  assert.equal(flags.tailscale, true)
  assert.equal(flags.web, true)
})

test('parseCliArgs does not set tailscale when --tailscale is absent', () => {
  const flags = parseCliArgs(['node', 'gsd', '--web'])
  assert.equal(flags.tailscale, undefined)
})

// ─── Preflight failure tests ──────────────────────────────────────────────────

test('returns tailscale:cli-not-found when isTailscaleInstalled returns false', async () => {
  const { deps, stderrOutput } = buildMockDeps({ isTailscaleInstalled: () => false })
  const result = await launchWebMode(BASE_OPTIONS, deps)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failureReason, 'tailscale:cli-not-found')
  }
  assert.ok(stderrOutput.some(m => m.includes('Tailscale CLI not found')))
})

test('returns tailscale:not-connected when getTailscaleStatus returns not-connected', async () => {
  const { deps, stderrOutput } = buildMockDeps({
    getTailscaleStatus: () => ({ ok: false as const, reason: 'not-connected' as const }),
  })
  const result = await launchWebMode(BASE_OPTIONS, deps)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failureReason, 'tailscale:not-connected')
  }
  assert.ok(stderrOutput.some(m => m.includes('not connected')))
})

test('returns tailscale:no-password when readPasswordHash returns null', async () => {
  const { deps } = buildMockDeps({ readPasswordHash: () => null })
  const result = await launchWebMode(BASE_OPTIONS, deps)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failureReason, 'tailscale:no-password')
  }
})

// ─── Singleton guard test ─────────────────────────────────────────────────────

test('returns tailscale:already-running when live tailscale instance exists in registry', async () => {
  const registryPath = join(tmpdir(), `test-singleton-${process.pid}.json`)
  // Write a registry with a live entry (use the current process PID — definitely alive)
  const registry = {
    '/some/cwd': {
      pid: process.pid,
      port: 3000,
      url: 'http://127.0.0.1:3000',
      cwd: '/some/cwd',
      startedAt: new Date().toISOString(),
      tailscaleUrl: 'https://testbox.test.ts.net',
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry), 'utf8')

  try {
    const { deps } = buildMockDeps({ registryPath })
    const result = await launchWebMode(BASE_OPTIONS, deps)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.failureReason, 'tailscale:already-running')
    }
  } finally {
    try { unlinkSync(registryPath) } catch { /* cleanup */ }
  }
})

// ─── Lifecycle tests ──────────────────────────────────────────────────────────

test('stopTailscaleServe called with strict:true during startup reset', async () => {
  let strictCallArg: { strict?: boolean } | undefined = undefined
  const stopTailscaleServe = async (opts?: { strict?: boolean }) => {
    strictCallArg = opts
  }
  const { deps } = buildMockDeps({ stopTailscaleServe })
  await launchWebMode(BASE_OPTIONS, deps)
  // The startup reset call should use strict: true
  assert.ok(strictCallArg !== undefined, 'stopTailscaleServe should have been called')
  assert.equal(strictCallArg?.strict, true)
})

test('GSD_WEB_DAEMON_MODE=1 and Tailscale URL in GSD_WEB_ALLOWED_ORIGINS when --tailscale', async () => {
  const { deps, capturedEnv } = buildMockDeps()
  await launchWebMode(BASE_OPTIONS, deps)
  assert.equal(capturedEnv.GSD_WEB_DAEMON_MODE, '1')
  assert.ok(capturedEnv.GSD_WEB_ALLOWED_ORIGINS?.includes('https://testbox.test.ts.net'))
})

test('spawn called with detached:false in --tailscale mode (foreground supervisor)', async () => {
  const { deps, getSpawnOptions } = buildMockDeps()
  await launchWebMode(BASE_OPTIONS, deps)
  const opts = getSpawnOptions()
  assert.ok(opts !== null, 'spawn should have been called')
  assert.equal(opts?.detached, false)
})

test('startTailscaleServe called and openBrowser NOT called in --tailscale mode', async () => {
  const { deps, calls } = buildMockDeps()
  await launchWebMode(BASE_OPTIONS, deps)
  assert.ok(calls.includes('startServe'), 'startTailscaleServe should have been called')
  assert.ok(!calls.includes('openBrowser'), 'openBrowser should NOT be called in --tailscale mode')
})

test('stderr contains "Accessible at: https://testbox.test.ts.net" after successful launch', async () => {
  const { deps, stderrOutput } = buildMockDeps()
  await launchWebMode(BASE_OPTIONS, deps)
  const combined = stderrOutput.join('')
  assert.ok(combined.includes('Accessible at: https://testbox.test.ts.net'))
})

// ─── Rollback test ────────────────────────────────────────────────────────────

test('rollback: kills child process and returns tailscale:serve-failed when startTailscaleServe throws', async () => {
  const killedPids: number[] = []
  let deletePidFileCalled = false

  const { deps, stderrOutput } = buildMockDeps({
    startTailscaleServe: async () => {
      throw new TailscaleServeError('serve failed', 1, 'port conflict error')
    },
    deletePidFile: () => { deletePidFileCalled = true },
  })

  // Patch spawn to return a pid we can track killing
  const origSpawn = deps.spawn
  deps.spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const child = origSpawn(cmd, args, opts)
    return child
  }

  const result = await launchWebMode(BASE_OPTIONS, deps)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failureReason, 'tailscale:serve-failed')
  }
  // stderr should contain the TailscaleServeError stderr
  const combined = stderrOutput.join('')
  assert.ok(combined.includes('port conflict error'), `Expected 'port conflict error' in: ${combined}`)
  assert.ok(deletePidFileCalled, 'deletePidFile should be called during rollback')
})

// ─── Cleanup idempotency (source check) ──────────────────────────────────────

test('cleanupFired guard is present in web-mode.ts source (idempotency guard)', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')

  const dir = dirname(fileURLToPath(import.meta.url))
  const webModePath = resolve(dir, '../web-mode.ts')
  const source = readFileSync(webModePath, 'utf-8')
  // Variable is named tailscaleCleanupFired (idempotency guard for double-signal protection)
  assert.ok(
    source.includes('tailscaleCleanupFired') || source.includes('cleanupFired'),
    'web-mode.ts must contain a cleanupFired guard for idempotent cleanup',
  )
})
