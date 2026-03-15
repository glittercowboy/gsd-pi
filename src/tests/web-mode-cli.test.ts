import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const projectRoot = process.cwd()

const cliWeb = await import('../cli-web-branch.ts')
const webMode = await import('../web-mode.ts')

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
  assert.ok(rootPackage.files.includes('dist/web'))

  const webPackage = JSON.parse(readFileSync(join(projectRoot, 'web', 'package.json'), 'utf-8'))
  assert.equal(webPackage.scripts['start:standalone'], 'node .next/standalone/web/server.js')
})

test('web mode launcher reuses the onboarding browser opener', () => {
  const source = readFileSync(join(projectRoot, 'src', 'web-mode.ts'), 'utf-8')
  assert.match(source, /from '\.\/onboarding\.js'/)
  assert.match(source, /openBrowser/)
})

test('cli.ts branches to web mode before interactive startup and preserves cwd-scoped launch inputs', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-cli-'))
  const cwd = join(tmp, 'project space')
  mkdirSync(cwd, { recursive: true })

  let launchInputs: { cwd: string; projectSessionsDir: string; agentDir: string } | undefined

  try {
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
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('launchWebMode prefers the packaged standalone host and opens the resolved URL', async () => {
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

  try {
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
    assert.equal(openedUrl, 'http://127.0.0.1:45123')
    assert.deepEqual(spawnInvocation, {
      command: '/custom/node',
      args: [serverPath],
      options: {
        cwd: standaloneRoot,
        detached: true,
        stdio: 'ignore',
        env: {
          TEST_ENV: '1',
          HOSTNAME: '127.0.0.1',
          PORT: '45123',
          GSD_WEB_HOST: '127.0.0.1',
          GSD_WEB_PORT: '45123',
          GSD_WEB_PROJECT_CWD: '/tmp/current-project',
          GSD_WEB_PROJECT_SESSIONS_DIR: '/tmp/.gsd/sessions/--tmp-current-project--',
          GSD_WEB_PACKAGE_ROOT: tmp,
          GSD_WEB_HOST_KIND: 'packaged-standalone',
        },
      },
    })
    assert.match(stderrOutput, /status=started/)
    assert.match(stderrOutput, /port=45123/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('launch failure surfaces status and reason before browser open', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-missing-host-'))
  let openedUrl = ''
  let stderrOutput = ''

  try {
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
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
