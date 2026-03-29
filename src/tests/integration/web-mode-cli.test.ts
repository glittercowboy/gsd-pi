import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const projectRoot = process.cwd()

const cliWeb = await import('../../cli-web-branch.ts')
const webMode = await import('../../web-mode.ts')

test('parseCliArgs recognizes --web explicitly', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web'])
  assert.equal(flags.web, true)
  assert.equal(flags.print, undefined)
  assert.equal(flags.mode, undefined)
})

test('package hooks declare a concrete staged web host', () => {
  const rootPackage = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'))
  assert.equal(rootPackage.scripts['stage:web-host'], 'node scripts/stage-web-standalone.cjs')
  assert.equal(rootPackage.scripts['build:web-host'], 'npm --prefix web run build && npm run stage:web-host')
  assert.equal(rootPackage.scripts['gsd'], 'node scripts/dev-cli.js')
  assert.equal(rootPackage.scripts['gsd:web'], 'npm run build:pi && npm run copy-resources && node scripts/build-web-if-stale.cjs && node scripts/dev-cli.js --web')
  assert.equal(rootPackage.scripts['gsd:web:stop'], 'node scripts/dev-cli.js web stop')
  assert.ok(rootPackage.files.includes('dist/web'))

  const webPackage = JSON.parse(readFileSync(join(projectRoot, 'web', 'package.json'), 'utf-8'))
  assert.equal(webPackage.scripts['start:standalone'], 'node .next/standalone/web/server.js')
})

test('web mode launcher defines or imports a browser opener', () => {
  const source = readFileSync(join(projectRoot, 'src', 'web-mode.ts'), 'utf-8')
  // openBrowser is now defined directly in web-mode.ts (was previously imported from onboarding.js)
  assert.match(source, /openBrowser/)
})

test('cli.ts branches to web mode before interactive startup and preserves cwd-scoped launch inputs', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-cli-'))
  const cwd = join(tmp, 'project space')
  mkdirSync(cwd, { recursive: true })

  let launchInputs: { cwd: string; projectSessionsDir: string; agentDir: string } | undefined

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const cliSource = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')
  const branchIndex = cliSource.indexOf('const webBranch = await runWebCliBranch')
  const modelRegistryIndex = cliSource.indexOf('const modelRegistry =')
  assert.ok(branchIndex !== -1, 'cli.ts contains an explicit web branch handoff')
  assert.ok(modelRegistryIndex !== -1, 'cli.ts still contains the model-registry startup path')
  assert.ok(branchIndex < modelRegistryIndex, 'web branch runs before interactive startup state is constructed')

  const result = await cliWeb.runWebCliBranch(cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web']), {
    cwd: () => cwd,
    runWebMode: async (options) => {
      launchInputs = options
      return {
        mode: 'web',
        ok: true,
        cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host: '127.0.0.1',
        port: 43123,
        url: 'http://127.0.0.1:43123',
        hostKind: 'source-dev',
        hostPath: '/tmp/fake-web/package.json',
        hostRoot: '/tmp/fake-web',
      }
    },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected --web branch to be handled')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(launchInputs, {
    cwd,
    projectSessionsDir: cliWeb.getProjectSessionsDir(cwd),
    agentDir: join(process.env.HOME || '', '.gsd', 'agent'),
    host: undefined,
    port: undefined,
    allowedOrigins: undefined,
  })
})

test('launchWebMode prefers the packaged standalone host and opens the resolved URL', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-host-'))
  const standaloneRoot = join(tmp, 'dist', 'web', 'standalone')
  const serverPath = join(standaloneRoot, 'server.js')
  mkdirSync(standaloneRoot, { recursive: true })
  writeFileSync(serverPath, 'console.log("stub")\n')

  let initResourcesCalled = false
  let unrefCalled = false
  let openedUrl = ''
  let stderrOutput = ''
  let spawnInvocation:
    | { command: string; args: readonly string[]; options: Record<string, any> }
    | undefined
  let writtenPid: { path: string; pid: number } | undefined

  const pidFilePath = join(tmp, 'web-server.pid')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/current-project',
      projectSessionsDir: '/tmp/.gsd/sessions/--tmp-current-project--',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
    },
    {
      initResources: () => {
        initResourcesCalled = true
      },
      resolvePort: async () => 45123,
      execPath: '/custom/node',
      env: { TEST_ENV: '1' },
      spawn: (command, args, options) => {
        spawnInvocation = { command, args, options: options as Record<string, any> }
        return {
          pid: 99999,
          once: () => undefined,
          unref: () => {
            unrefCalled = true
          },
        } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: (url) => {
        openedUrl = url
      },
      pidFilePath,
      writePidFile: (path, pid) => {
        writtenPid = { path, pid }
        webMode.writePidFile(path, pid)
      },
      stderr: {
        write(chunk: string) {
          stderrOutput += chunk
          return true
        },
      },
    },
  )

  assert.equal(status.ok, true)
  if (!status.ok) throw new Error('expected successful web launch status')
  assert.equal(status.hostKind, 'packaged-standalone')
  assert.equal(status.hostPath, serverPath)
  assert.equal(status.url, 'http://127.0.0.1:45123')
  assert.equal(initResourcesCalled, true)
  assert.equal(unrefCalled, true)
  // The browser URL now includes a random auth token as a fragment
  assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:45123\/#token=[a-f0-9]{64}$/)
  // Extract the auth token the launcher generated so we can verify it was
  // passed consistently to both the env and the browser URL.
  const authToken = openedUrl.replace('http://127.0.0.1:45123/#token=', '')
  assert.deepEqual(spawnInvocation, {
    command: '/custom/node',
    args: [serverPath],
    options: {
      cwd: standaloneRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        TEST_ENV: '1',
        HOSTNAME: '127.0.0.1',
        PORT: '45123',
        GSD_WEB_HOST: '127.0.0.1',
        GSD_WEB_PORT: '45123',
        GSD_WEB_AUTH_TOKEN: authToken,
        GSD_WEB_PROJECT_CWD: '/tmp/current-project',
        GSD_WEB_PROJECT_SESSIONS_DIR: '/tmp/.gsd/sessions/--tmp-current-project--',
        GSD_WEB_PACKAGE_ROOT: tmp,
        GSD_WEB_HOST_KIND: 'packaged-standalone',
      },
    },
  })
  assert.match(stderrOutput, /status=started/)
  assert.match(stderrOutput, /port=45123/)
  // PID file must be written with the spawned process's PID
  assert.deepEqual(writtenPid, { path: pidFilePath, pid: 99999 })
  assert.equal(webMode.readPidFile(pidFilePath), 99999)
})

test('stopWebMode kills process by PID and removes PID file', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-stop-'))
  const pidFilePath = join(tmp, 'web-server.pid')
  let stderrOutput = ''
  let killedPid: number | undefined

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  webMode.writePidFile(pidFilePath, 12345)

  const result = webMode.stopWebMode({
    pidFilePath,
    readPidFile: webMode.readPidFile,
    deletePidFile: webMode.deletePidFile,
    stderr: { write: (chunk: string) => { stderrOutput += chunk; return true } },
    // Override process.kill to avoid killing a real process in tests
  })

  // Since PID 12345 is almost certainly dead, stopWebMode should succeed by treating ESRCH as "already gone"
  assert.equal(result.ok, true)
  assert.match(stderrOutput, /pid=12345/)
})

test('stopWebMode reports error when no PID file exists', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-stop-nopid-'))
  const pidFilePath = join(tmp, 'web-server.pid')
  let stderrOutput = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const result = webMode.stopWebMode({
    pidFilePath,
    readPidFile: webMode.readPidFile,
    deletePidFile: webMode.deletePidFile,
    stderr: { write: (chunk: string) => { stderrOutput += chunk; return true } },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-pid-file')
  assert.match(stderrOutput, /not running/)
})

test('runWebCliBranch handles "web stop" subcommand without --web flag', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-branch-stop-'))
  const pidFilePath = join(tmp, 'web-server.pid')
  let stderrOutput = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', 'web', 'stop'])
  assert.equal(flags.web, undefined)
  assert.deepEqual(flags.messages, ['web', 'stop'])

  const result = await cliWeb.runWebCliBranch(flags, {
    stopWebMode: (deps) => {
      return webMode.stopWebMode({ ...deps, pidFilePath })
    },
    stderr: { write: (chunk: string) => { stderrOutput += chunk; return true } },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected web stop to be handled')
  assert.equal(result.exitCode, 1) // no PID file — expected failure
  if (result.action !== 'stop') throw new Error('expected action=stop')
  assert.equal(result.stopResult.ok, false)
})

// ─── Path argument tests ──────────────────────────────────────────────

test('parseCliArgs captures --web <path>', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '/tmp/my-project'])
  assert.equal(flags.web, true)
  assert.equal(flags.webPath, '/tmp/my-project')
  assert.deepEqual(flags.messages, [])
})

test('parseCliArgs captures --web with relative path', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '../other-project'])
  assert.equal(flags.web, true)
  assert.equal(flags.webPath, '../other-project')
})

test('parseCliArgs does not capture --web followed by a flag as path', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '--model', 'test'])
  assert.equal(flags.web, true)
  assert.equal(flags.webPath, undefined)
  assert.equal(flags.model, 'test')
})

test('gsd web <path> is handled as web start with path', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-path-'))
  const projectDir = join(tmp, 'my-project')
  mkdirSync(projectDir, { recursive: true })
  let launchedCwd = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', 'web', projectDir])
  assert.deepEqual(flags.messages, ['web', projectDir])

  const result = await cliWeb.runWebCliBranch(flags, {
    runWebMode: async (options) => {
      launchedCwd = options.cwd
      return {
        mode: 'web',
        ok: true,
        cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host: '127.0.0.1',
        port: 43124,
        url: 'http://127.0.0.1:43124',
        hostKind: 'source-dev',
        hostPath: '/tmp/fake-web/package.json',
        hostRoot: '/tmp/fake-web',
      }
    },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected web branch to be handled')
  assert.equal(result.exitCode, 0)
  assert.equal(launchedCwd, projectDir)
})

test('gsd web start <path> resolves path and launches', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-start-path-'))
  const projectDir = join(tmp, 'another-project')
  mkdirSync(projectDir, { recursive: true })
  let launchedCwd = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', 'web', 'start', projectDir])
  assert.deepEqual(flags.messages, ['web', 'start', projectDir])

  const result = await cliWeb.runWebCliBranch(flags, {
    runWebMode: async (options) => {
      launchedCwd = options.cwd
      return {
        mode: 'web',
        ok: true,
        cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host: '127.0.0.1',
        port: 43125,
        url: 'http://127.0.0.1:43125',
        hostKind: 'source-dev',
        hostPath: '/tmp/fake-web/package.json',
        hostRoot: '/tmp/fake-web',
      }
    },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected web branch to be handled')
  assert.equal(result.exitCode, 0)
  assert.equal(launchedCwd, projectDir)
})

test('gsd --web <path> resolves path and launches', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-flag-path-'))
  const projectDir = join(tmp, 'flagged-project')
  mkdirSync(projectDir, { recursive: true })
  let launchedCwd = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', projectDir])
  assert.equal(flags.web, true)
  assert.equal(flags.webPath, projectDir)

  const result = await cliWeb.runWebCliBranch(flags, {
    runWebMode: async (options) => {
      launchedCwd = options.cwd
      return {
        mode: 'web',
        ok: true,
        cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host: '127.0.0.1',
        port: 43126,
        url: 'http://127.0.0.1:43126',
        hostKind: 'source-dev',
        hostPath: '/tmp/fake-web/package.json',
        hostRoot: '/tmp/fake-web',
      }
    },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected web branch to be handled')
  assert.equal(result.exitCode, 0)
  assert.equal(launchedCwd, projectDir)
})

test('gsd --web <nonexistent-path> fails with clear error', async () => {
  let stderrOutput = ''

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '/tmp/nonexistent-gsd-test-path-xyz'])
  const result = await cliWeb.runWebCliBranch(flags, {
    stderr: { write: (chunk: string) => { stderrOutput += chunk; return true } },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected web branch to be handled')
  assert.equal(result.exitCode, 1)
  if (result.action !== 'start') throw new Error('expected action=start')
  assert.equal(result.status.ok, false)
  if (result.status.ok) throw new Error('expected failed status')
  assert.match(result.status.failureReason, /does not exist/)
  assert.match(stderrOutput, /does not exist/)
})

test('launch failure surfaces status and reason before browser open', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-missing-host-'))
  let openedUrl = ''
  let stderrOutput = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/current-project',
      projectSessionsDir: '/tmp/.gsd/sessions/--tmp-current-project--',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
    },
    {
      openBrowser: (url) => {
        openedUrl = url
      },
      stderr: {
        write(chunk: string) {
          stderrOutput += chunk
          return true
        },
      },
    },
  )

  assert.equal(status.ok, false)
  if (status.ok) throw new Error('expected failed web launch status')
  assert.equal(status.hostPath, null)
  assert.equal(status.url, null)
  assert.equal(openedUrl, '')
  assert.match(status.failureReason, /host bootstrap not found/)
  assert.match(stderrOutput, /status=failed/)
  assert.match(stderrOutput, /reason=host bootstrap not found/)
})

// ─── Instance registry tests ─────────────────────────────────────────

test('registerInstance and readInstanceRegistry round-trip', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-registry-'))
  const registryPath = join(tmp, 'web-instances.json')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  webMode.registerInstance('/tmp/project-a', { pid: 1001, port: 3000, url: 'http://127.0.0.1:3000' }, registryPath)
  webMode.registerInstance('/tmp/project-b', { pid: 1002, port: 3001, url: 'http://127.0.0.1:3001' }, registryPath)

  const registry = webMode.readInstanceRegistry(registryPath)
  assert.equal(Object.keys(registry).length, 2)
  assert.equal(registry[resolve('/tmp/project-a')]?.pid, 1001)
  assert.equal(registry[resolve('/tmp/project-b')]?.port, 3001)
  assert.ok(registry[resolve('/tmp/project-a')]?.startedAt)
})

test('unregisterInstance removes a single entry', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-unreg-'))
  const registryPath = join(tmp, 'web-instances.json')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  webMode.registerInstance('/tmp/project-a', { pid: 1001, port: 3000, url: 'http://127.0.0.1:3000' }, registryPath)
  webMode.registerInstance('/tmp/project-b', { pid: 1002, port: 3001, url: 'http://127.0.0.1:3001' }, registryPath)
  webMode.unregisterInstance('/tmp/project-a', registryPath)

  const registry = webMode.readInstanceRegistry(registryPath)
  assert.equal(Object.keys(registry).length, 1)
  assert.equal(registry[resolve('/tmp/project-a')], undefined)
  assert.equal(registry[resolve('/tmp/project-b')]?.pid, 1002)
})

test('stopWebMode with projectCwd reports not-found when not in registry', () => {
  let stderrOutput = ''

  const result = webMode.stopWebMode(
    { stderr: { write: (chunk: string) => { stderrOutput += chunk; return true } } },
    { projectCwd: '/tmp/nonexistent-project-for-stop-test' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-found')
  assert.match(stderrOutput, /No web server running/)
})

test('gsd web stop all is parsed and dispatched', async () => {
  let stopOptions: { projectCwd?: string; all?: boolean } | undefined

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', 'web', 'stop', 'all'])
  assert.deepEqual(flags.messages, ['web', 'stop', 'all'])

  const result = await cliWeb.runWebCliBranch(flags, {
    stopWebMode: (_deps, opts) => {
      stopOptions = opts
      return { ok: true, stoppedCount: 2 }
    },
    stderr: { write: () => true },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected handled')
  assert.equal(result.exitCode, 0)
  assert.equal(stopOptions?.all, true)
  assert.equal(stopOptions?.projectCwd, undefined)
})

test('gsd web stop <path> is parsed and dispatched with resolved path', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-stop-path-'))
  let stopOptions: { projectCwd?: string; all?: boolean } | undefined

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', 'web', 'stop', tmp])
  const result = await cliWeb.runWebCliBranch(flags, {
    cwd: () => '/',
    stopWebMode: (_deps, opts) => {
      stopOptions = opts
      return { ok: true, stoppedCount: 1 }
    },
    stderr: { write: () => true },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected handled')
  assert.equal(result.exitCode, 0)
  assert.equal(stopOptions?.projectCwd, tmp)
  assert.equal(stopOptions?.all, false)
})

// ─── Context-aware launch detection tests ──────────────────────────────

test('resolveContextAwareCwd returns project cwd when inside a project under dev root', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const devRoot = join(tmp, 'devroot')
  const projectA = join(devRoot, 'projectA')
  const prefsPath = join(tmp, 'web-preferences.json')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(projectA, { recursive: true })
  writeFileSync(prefsPath, JSON.stringify({ devRoot }))

  const result = cliWeb.resolveContextAwareCwd(projectA, prefsPath)
  assert.equal(result, projectA)
})

test('resolveContextAwareCwd returns cwd unchanged when AT dev root', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const devRoot = join(tmp, 'devroot')
  const prefsPath = join(tmp, 'web-preferences.json')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(devRoot, { recursive: true })
  writeFileSync(prefsPath, JSON.stringify({ devRoot }))

  const result = cliWeb.resolveContextAwareCwd(devRoot, prefsPath)
  assert.equal(result, devRoot)
})

test('resolveContextAwareCwd returns cwd unchanged when no dev root configured', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const prefsPath = join(tmp, 'web-preferences.json')
  const cwd = join(tmp, 'somedir')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(cwd, { recursive: true })
  writeFileSync(prefsPath, JSON.stringify({ theme: 'dark' }))

  const result = cliWeb.resolveContextAwareCwd(cwd, prefsPath)
  assert.equal(result, cwd)
})

test('resolveContextAwareCwd returns cwd unchanged when prefs file missing', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const prefsPath = join(tmp, 'nonexistent-prefs.json')
  const cwd = join(tmp, 'somedir')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(cwd, { recursive: true })

  const result = cliWeb.resolveContextAwareCwd(cwd, prefsPath)
  assert.equal(result, cwd)
})

test('resolveContextAwareCwd returns cwd unchanged when dev root path is stale', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const prefsPath = join(tmp, 'web-preferences.json')
  const cwd = join(tmp, 'somedir')
  const staleDevRoot = join(tmp, 'nonexistent-devroot')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(cwd, { recursive: true })
  writeFileSync(prefsPath, JSON.stringify({ devRoot: staleDevRoot }))

  const result = cliWeb.resolveContextAwareCwd(cwd, prefsPath)
  assert.equal(result, cwd)
})

test('resolveContextAwareCwd resolves nested cwd to one-level-deep project', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const devRoot = join(tmp, 'devroot')
  const projectA = join(devRoot, 'projectA')
  const nested = join(projectA, 'src', 'components', 'deep')
  const prefsPath = join(tmp, 'web-preferences.json')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(nested, { recursive: true })
  writeFileSync(prefsPath, JSON.stringify({ devRoot }))

  const result = cliWeb.resolveContextAwareCwd(nested, prefsPath)
  assert.equal(result, projectA)
})

test('resolveContextAwareCwd returns cwd unchanged when outside dev root', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ctx-aware-'))
  const devRoot = join(tmp, 'devroot')
  const outsideDir = join(tmp, 'elsewhere')
  const prefsPath = join(tmp, 'web-preferences.json')

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  mkdirSync(devRoot, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(prefsPath, JSON.stringify({ devRoot }))

  const result = cliWeb.resolveContextAwareCwd(outsideDir, prefsPath)
  assert.equal(result, outsideDir)
})

// ─── Stale instance cleanup tests ─────────────────────────────────────

test('launchWebMode kills stale instance for same cwd before spawning', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-stale-'))
  const standaloneRoot = join(tmp, 'dist', 'web', 'standalone')
  const serverPath = join(standaloneRoot, 'server.js')
  mkdirSync(standaloneRoot, { recursive: true })
  writeFileSync(serverPath, 'console.log("stub")\n')

  const registryPath = join(tmp, 'web-instances.json')
  const pidFilePath = join(tmp, 'web-server.pid')
  const cwd = '/tmp/stale-project'

  // Pre-register a stale instance for the same cwd
  webMode.registerInstance(cwd, { pid: 77777, port: 3000, url: 'http://127.0.0.1:3000' }, registryPath)

  let stderrOutput = ''
  let spawnCalled = false

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd,
      projectSessionsDir: '/tmp/.gsd/sessions/stale',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45200,
      execPath: '/custom/node',
      env: { TEST_ENV: '1' },
      spawn: (command, args, options) => {
        spawnCalled = true
        return {
          pid: 88888,
          once: () => undefined,
          unref: () => {},
        } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      pidFilePath,
      writePidFile: webMode.writePidFile,
      registryPath,
      stderr: {
        write(chunk: string) {
          stderrOutput += chunk
          return true
        },
      },
    },
  )

  assert.equal(status.ok, true)
  assert.equal(spawnCalled, true)
  // Stale instance for same cwd should have been cleaned up
  assert.match(stderrOutput, /Cleaning up stale/)
  // New instance should be registered
  const registry = webMode.readInstanceRegistry(registryPath)
  assert.equal(registry[resolve(cwd)]?.pid, 88888)
})

test('launchWebMode does not log cleanup when no stale instance exists', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-no-stale-'))
  const standaloneRoot = join(tmp, 'dist', 'web', 'standalone')
  const serverPath = join(standaloneRoot, 'server.js')
  mkdirSync(standaloneRoot, { recursive: true })
  writeFileSync(serverPath, 'console.log("stub")\n')

  const registryPath = join(tmp, 'web-instances.json')
  const pidFilePath = join(tmp, 'web-server.pid')

  let stderrOutput = ''

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/clean-project',
      projectSessionsDir: '/tmp/.gsd/sessions/clean',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45201,
      execPath: '/custom/node',
      env: { TEST_ENV: '1' },
      spawn: () => ({
        pid: 88889,
        once: () => undefined,
        unref: () => {},
      } as any),
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      pidFilePath,
      writePidFile: webMode.writePidFile,
      registryPath,
      stderr: {
        write(chunk: string) {
          stderrOutput += chunk
          return true
        },
      },
    },
  )

  assert.equal(status.ok, true)
  // No cleanup message when no stale instance exists
  assert.equal(stderrOutput.includes('Cleaning up stale'), false)
})
