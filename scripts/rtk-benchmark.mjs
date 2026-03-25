#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

function getManagedRtkPath() {
  return join(homedir(), '.gsd', 'agent', 'bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function ensureOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
}

function createFixture(projectDir) {
  mkdirSync(join(projectDir, 'src', 'components'), { recursive: true })

  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    name: 'gsd-rtk-benchmark',
    version: '1.0.0',
    scripts: {
      test: 'node test.js',
    },
  }, null, 2))

  const testLines = []
  for (let i = 0; i < 120; i += 1) {
    const group = i % 6
    testLines.push(`console.log('FAIL src/components/file${group}.test.ts:${i + 1}: expected value ${i}')`)
  }
  testLines.push('process.exit(1)')
  writeFileSync(join(projectDir, 'test.js'), `${testLines.join('\n')}\n`)

  for (let i = 1; i <= 80; i += 1) {
    writeFileSync(
      join(projectDir, 'src', 'components', `file${i}.ts`),
      `export function component_${i}() {\n  return "value_${i}";\n}\n`,
    )
  }

  ensureOk(run('git', ['init', '-q'], { cwd: projectDir }), 'git init')
  ensureOk(run('git', ['config', 'user.email', 'benchmark@example.com'], { cwd: projectDir }), 'git config email')
  ensureOk(run('git', ['config', 'user.name', 'Benchmark'], { cwd: projectDir }), 'git config name')
  ensureOk(run('git', ['add', '.'], { cwd: projectDir }), 'git add')
  ensureOk(run('git', ['commit', '-qm', 'init'], { cwd: projectDir }), 'git commit')

  for (let i = 1; i <= 25; i += 1) {
    writeFileSync(
      join(projectDir, 'src', 'components', `file${i}.ts`),
      `export function component_${i}() {\n  return "value_${i}";\n}\n// change ${i}\n`,
    )
  }

  for (let i = 81; i <= 100; i += 1) {
    writeFileSync(
      join(projectDir, 'src', 'components', `file${i}.ts`),
      `export const new_${i} = ${i}\n`,
    )
  }
}

function renderMarkdown({ summary, history, binaryPath }) {
  const timestamp = new Date().toISOString()
  return [
    '# RTK benchmark evidence',
    '',
    `- Generated: ${timestamp}`,
    `- RTK binary: \`${binaryPath}\``,
    `- Telemetry: disabled via \`RTK_TELEMETRY_DISABLED=1\``,
    `- Fixture: synthetic git + find + ls + npm test workload`,
    '',
    '## Aggregate savings',
    '',
    '| Commands | Input tokens | Output tokens | Saved tokens | Savings | Avg command time |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| ${summary.total_commands} | ${summary.total_input} | ${summary.total_output} | ${summary.total_saved} | ${summary.avg_savings_pct.toFixed(1)}% | ${summary.avg_time_ms} ms |`,
    '',
    '## Command breakdown',
    '',
    '```text',
    history.trim(),
    '```',
    '',
    '## Commands exercised',
    '',
    '- `git status`',
    '- `git diff`',
    '- `find src -type f`',
    '- `ls -R src`',
    '- `npm run test`',
    '',
  ].join('\n')
}

function main() {
  const outputIndex = process.argv.indexOf('--output')
  const outputPath = outputIndex !== -1 ? process.argv[outputIndex + 1] : null
  const binaryPath = process.env.GSD_RTK_PATH || getManagedRtkPath()

  if (!binaryPath) {
    throw new Error('RTK binary path not resolved')
  }

  const workspace = mkdtempSync(join(tmpdir(), 'gsd-rtk-benchmark-'))
  const homeDir = join(workspace, 'home')
  const projectDir = join(workspace, 'project')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  try {
    createFixture(projectDir)

    const env = {
      ...process.env,
      HOME: homeDir,
      RTK_TELEMETRY_DISABLED: '1',
    }

    const commands = [
      ['git', 'status'],
      ['git', 'diff'],
      ['find', 'src', '-type', 'f'],
      ['ls', '-R', 'src'],
      ['npm', 'run', 'test'],
    ]

    for (const command of commands) {
      run(binaryPath, command, { cwd: projectDir, env })
    }

    const summaryJson = run(binaryPath, ['gain', '--all', '--format', 'json'], { cwd: projectDir, env })
    ensureOk(summaryJson, 'rtk gain --all --format json')
    const historyText = run(binaryPath, ['gain', '--history'], { cwd: projectDir, env })
    ensureOk(historyText, 'rtk gain --history')

    const parsed = JSON.parse(summaryJson.stdout)
    const markdown = renderMarkdown({
      summary: parsed.summary,
      history: historyText.stdout,
      binaryPath,
    })

    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, markdown, 'utf-8')
      console.log(outputPath)
      return
    }

    console.log(markdown)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

main()
