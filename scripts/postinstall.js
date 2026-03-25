#!/usr/bin/env node

import { exec as execCb, spawnSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { arch, homedir, platform } from 'os'
import { dirname, resolve, join } from 'path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import extractZip from 'extract-zip'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cwd = resolve(__dirname, '..')
const PLAYWRIGHT_SKIP =
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === 'true'
const RTK_SKIP =
  process.env.GSD_SKIP_RTK_INSTALL === '1' ||
  process.env.GSD_SKIP_RTK_INSTALL === 'true' ||
  process.env.GSD_RTK_DISABLED === '1' ||
  process.env.GSD_RTK_DISABLED === 'true'

const RTK_VERSION = '0.33.1'
const RTK_REPO = 'rtk-ai/rtk'
const RTK_ENV = { ...process.env, RTK_TELEMETRY_DISABLED: '1' }
const managedBinDir = join(process.env.GSD_HOME || join(homedir(), '.gsd'), 'agent', 'bin')
const managedBinaryPath = join(managedBinDir, platform() === 'win32' ? 'rtk.exe' : 'rtk')

function run(cmd) {
  return new Promise((resolvePromise) => {
    execCb(cmd, { cwd }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout, stderr })
    })
  })
}

function logWarn(message) {
  process.stderr.write(`[gsd] postinstall: ${message}\n`)
}

function resolveAssetName() {
  const currentPlatform = platform()
  const currentArch = arch()
  if (currentPlatform === 'darwin' && currentArch === 'arm64') return 'rtk-aarch64-apple-darwin.tar.gz'
  if (currentPlatform === 'darwin' && currentArch === 'x64') return 'rtk-x86_64-apple-darwin.tar.gz'
  if (currentPlatform === 'linux' && currentArch === 'arm64') return 'rtk-aarch64-unknown-linux-gnu.tar.gz'
  if (currentPlatform === 'linux' && currentArch === 'x64') return 'rtk-x86_64-unknown-linux-musl.tar.gz'
  if (currentPlatform === 'win32' && currentArch === 'x64') return 'rtk-x86_64-pc-windows-msvc.zip'
  return null
}

function parseChecksums(text) {
  const checksums = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i)
    if (!match) continue
    checksums.set(match[2], match[1].toLowerCase())
  }
  return checksums
}

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'gsd-pi-postinstall' } })
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`)
  }
  if (!response.body) {
    throw new Error(`download returned no body for ${url}`)
  }
  const output = createWriteStream(destination)
  await finished(Readable.fromWeb(response.body).pipe(output))
}

function findBinaryRecursively(rootDir, binaryName) {
  const stack = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isFile() && entry.name === binaryName) return fullPath
      if (entry.isDirectory()) stack.push(fullPath)
    }
  }
  return null
}

function validateRtkBinary(binaryPath) {
  const result = spawnSync(binaryPath, ['rewrite', 'git status'], {
    encoding: 'utf-8',
    env: RTK_ENV,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  })
  return !result.error && result.status === 0 && (result.stdout || '').trim() === 'rtk git status'
}

async function ensureRtkInstalled() {
  if (RTK_SKIP) return
  const assetName = resolveAssetName()
  if (!assetName) return
  if (existsSync(managedBinaryPath) && validateRtkBinary(managedBinaryPath)) return

  const tempRoot = join(managedBinDir, `.rtk-postinstall-${randomUUID().slice(0, 8)}`)
  const archivePath = join(tempRoot, assetName)
  const extractDir = join(tempRoot, 'extract')
  const releaseBase = `https://github.com/${RTK_REPO}/releases/download/v${RTK_VERSION}`

  mkdirSync(tempRoot, { recursive: true })
  mkdirSync(managedBinDir, { recursive: true })

  try {
    const checksumsResponse = await fetch(`${releaseBase}/checksums.txt`, {
      headers: { 'User-Agent': 'gsd-pi-postinstall' },
    })
    if (!checksumsResponse.ok) {
      throw new Error(`failed to fetch RTK checksums (${checksumsResponse.status})`)
    }

    const checksums = parseChecksums(await checksumsResponse.text())
    const expectedSha = checksums.get(assetName)
    if (!expectedSha) {
      throw new Error(`missing checksum for ${assetName}`)
    }

    await downloadToFile(`${releaseBase}/${assetName}`, archivePath)
    const actualSha = sha256File(archivePath)
    if (actualSha !== expectedSha) {
      throw new Error(`checksum mismatch for ${assetName}`)
    }

    mkdirSync(extractDir, { recursive: true })
    if (assetName.endsWith('.zip')) {
      await extractZip(archivePath, { dir: extractDir })
    } else {
      const extractResult = spawnSync('tar', ['xzf', archivePath, '-C', extractDir], {
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (extractResult.error || extractResult.status !== 0) {
        throw new Error(extractResult.error?.message || extractResult.stderr?.trim() || `failed to extract ${assetName}`)
      }
    }

    const extractedBinary = findBinaryRecursively(extractDir, platform() === 'win32' ? 'rtk.exe' : 'rtk')
    if (!extractedBinary) {
      throw new Error(`RTK binary not found in ${assetName}`)
    }

    copyFileSync(extractedBinary, managedBinaryPath)
    if (platform() !== 'win32') {
      chmodSync(managedBinaryPath, 0o755)
    }

    if (!validateRtkBinary(managedBinaryPath)) {
      rmSync(managedBinaryPath, { force: true })
      throw new Error('downloaded RTK binary failed validation')
    }
  } catch (error) {
    logWarn(`RTK install skipped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (!PLAYWRIGHT_SKIP) {
  await run('npx playwright install chromium')
}

await ensureRtkInstalled()
