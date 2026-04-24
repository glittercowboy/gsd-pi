#!/usr/bin/env node

/**
 * GSD Interactive Installer
 *
 * Entry point for `npx gsd-pi` or `npx gsd-pi@latest`.
 * When invoked directly (not as a postinstall hook), runs the visual
 * installer with full terminal access — banner, spinners, progress.
 *
 * If GSD is already installed and the user runs `gsd`, this script
 * is NOT invoked — the normal loader.js handles that via the "gsd" bin.
 * This script only fires for `npx gsd-pi` (the package name bin).
 */

import { execSync, spawnSync, exec as execCb } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { arch, homedir, platform } from 'os'
import { dirname, resolve, join } from 'path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))

// packageRoot is always relative to this script — it's the gsd-pi package directory.
// This is correct whether running as postinstall (inside node_modules/gsd-pi) or
// via npx (inside a transient cache), since __dirname resolves to the script's location.
const IS_POSTINSTALL = !!process.env.npm_lifecycle_event
const packageRoot = resolve(__dirname, '..')

// ── Feature flags ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const HAS_HELP = args.includes('--help') || args.includes('-h')
const HAS_VERSION = args.includes('--version') || args.includes('-v')

// ── Colors ─────────────────────────────────────────────────────────────────

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = supportsColor
  ? { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { cyan: '', green: '', yellow: '', red: '', dim: '', bold: '', reset: '' }

// ── Version ────────────────────────────────────────────────────────────────

let gsdVersion = '0.0.0'
try {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'))
  gsdVersion = pkg.version || '0.0.0'
} catch { /* ignore */ }

if (HAS_VERSION) {
  process.stdout.write(gsdVersion + '\n')
  process.exit(0)
}

if (HAS_HELP) {
  process.stdout.write(`
  ${c.bold}GSD Installer${c.reset} ${c.dim}v${gsdVersion}${c.reset}

  ${c.yellow}Usage:${c.reset}
    npx gsd-pi@latest          Install GSD globally (recommended)
    npx gsd-pi@latest --local  Install GSD to current project

  ${c.yellow}Options:${c.reset}
    ${c.cyan}--local${c.reset}     Install to current directory instead of globally
    ${c.cyan}--skip-chromium${c.reset}  Skip Chromium browser download
    ${c.cyan}--skip-rtk${c.reset}      Skip RTK shell compression binary
    ${c.cyan}-h, --help${c.reset}      Show this help
    ${c.cyan}-v, --version${c.reset}   Show version

  ${c.yellow}Environment:${c.reset}
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  Skip Chromium
    GSD_SKIP_RTK_INSTALL=1              Skip RTK
    GSD_RTK_DISABLED=1                  Disable RTK integration

`)
  process.exit(0)
}

// ── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
let spinnerInterval = null
let spinnerFrame = 0

function startSpinner(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  … ${label}\n`)
    return
  }
  spinnerFrame = 0
  process.stdout.write(`  ${c.cyan}${SPINNER_FRAMES[0]}${c.reset} ${label}`)
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length
    process.stdout.write(`\r  ${c.cyan}${SPINNER_FRAMES[spinnerFrame]}${c.reset} ${label}`)
  }, 100)
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval)
    spinnerInterval = null
  }
  if (process.stdout.isTTY) {
    process.stdout.write('\r\x1b[2K')
  }
}

// ── Output helpers ─────────────────────────────────────────────────────────

function printBanner() {
  process.stdout.write(`
${c.cyan}   ██████╗ ███████╗██████╗
  ██╔════╝ ██╔════╝██╔══██╗
  ██║  ███╗███████╗██║  ██║
  ██║   ██║╚════██║██║  ██║
  ╚██████╔╝███████║██████╔╝
   ╚═════╝ ╚══════╝╚═════╝${c.reset}

  ${c.bold}Get Shit Done${c.reset} ${c.dim}v${gsdVersion}${c.reset}
`)
}

function printStep(label, detail) {
  const detailStr = detail ? ` ${c.dim}${detail}${c.reset}` : ''
  process.stdout.write(`  ${c.green}✓${c.reset} ${label}${detailStr}\n`)
}

function printSkip(label, reason) {
  process.stdout.write(`  ${c.dim}–${c.reset} ${label} ${c.dim}(${reason})${c.reset}\n`)
}

function printWarn(label, detail) {
  const detailStr = detail ? `: ${detail}` : ''
  process.stdout.write(`  ${c.yellow}⚠${c.reset} ${label}${detailStr}\n`)
}

function printFail(label, detail) {
  const detailStr = detail ? `: ${detail}` : ''
  process.stdout.write(`  ${c.red}✗${c.reset} ${label}${detailStr}\n`)
}

// ── Install logic ──────────────────────────────────────────────────────────

const PLAYWRIGHT_SKIP =
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === 'true' ||
  args.includes('--skip-chromium')

const RTK_SKIP =
  process.env.GSD_SKIP_RTK_INSTALL === '1' ||
  process.env.GSD_SKIP_RTK_INSTALL === 'true' ||
  process.env.GSD_RTK_DISABLED === '1' ||
  process.env.GSD_RTK_DISABLED === 'true' ||
  args.includes('--skip-rtk')

const RTK_VERSION = '0.33.1'
const RTK_REPO = 'rtk-ai/rtk'
const RTK_ENV = { ...process.env, RTK_TELEMETRY_DISABLED: '1' }
const managedBinDir = join(process.env.GSD_HOME || join(homedir(), '.gsd'), 'agent', 'bin')
const managedBinaryPath = join(managedBinDir, platform() === 'win32' ? 'rtk.exe' : 'rtk')

// ── Step: npm install -g ───────────────────────────────────────────────────

async function installGlobally() {
  startSpinner('Installing gsd-pi globally...             ')
  try {
    const result = await new Promise((res) => {
      execCb(
        `npm install -g gsd-pi@${gsdVersion}`,
        { timeout: 300_000 },
        (error, stdout, stderr) => {
          res({ ok: !error, stdout: stdout || '', stderr: stderr || '', error })
        }
      )
    })
    stopSpinner()

    if (!result.ok) {
      const meaningful = (result.stderr || '')
        .split('\n')
        .filter(l => !l.includes('npm warn') && !l.includes('npm WARN') && l.trim())
        .slice(-3)
        .join('; ')
      printFail('Global install failed', meaningful || 'run npm install -g gsd-pi manually')
      return false
    }

    printStep('Installed globally', 'npm install -g gsd-pi')
    return true
  } catch (err) {
    stopSpinner()
    printFail('Global install failed', err.message)
    return false
  }
}

async function installLocally() {
  startSpinner('Installing gsd-pi locally...              ')
  try {
    const result = await new Promise((res) => {
      execCb(
        `npm install gsd-pi@${gsdVersion}`,
        { cwd: process.cwd(), timeout: 300_000 },
        (error, stdout, stderr) => {
          res({ ok: !error, stdout: stdout || '', stderr: stderr || '', error })
        }
      )
    })
    stopSpinner()

    if (!result.ok) {
      const meaningful = (result.stderr || '')
        .split('\n')
        .filter(l => !l.includes('npm warn') && !l.includes('npm WARN') && l.trim())
        .slice(-3)
        .join('; ')
      printFail('Local install failed', meaningful || 'run npm install gsd-pi manually')
      return false
    }

    printStep('Installed locally', 'npm install gsd-pi')
    return true
  } catch (err) {
    stopSpinner()
    printFail('Local install failed', err.message)
    return false
  }
}

// ── Step: Playwright Chromium ──────────────────────────────────────────────

async function installChromium() {
  if (PLAYWRIGHT_SKIP) {
    printSkip('Chromium', 'skipped')
    return
  }

  startSpinner('Installing Chromium...                    ')
  try {
    const result = await new Promise((res) => {
      execCb('npx playwright install chromium', { timeout: 300_000 }, (error, stdout, stderr) => {
        res({ ok: !error, stdout: stdout || '', stderr: stderr || '', error })
      })
    })
    stopSpinner()

    if (!result.ok) {
      const output = (result.stderr + '\n' + result.stdout).trim()
      const meaningful = output.split('\n')
        .filter(l => !l.includes('npm warn') && !l.includes('npm WARN') && l.trim())
        .slice(-3)
        .join('; ')
      printWarn('Chromium', meaningful || 'install failed — run npx playwright install chromium')
      return
    }

    printStep('Chromium installed', 'Playwright')
  } catch (err) {
    stopSpinner()
    printWarn('Chromium', err.message)
  }
}

// ── Step: RTK ──────────────────────────────────────────────────────────────

function resolveAssetName() {
  const p = platform()
  const a = arch()
  if (p === 'darwin' && a === 'arm64') return 'rtk-aarch64-apple-darwin.tar.gz'
  if (p === 'darwin' && a === 'x64') return 'rtk-x86_64-apple-darwin.tar.gz'
  if (p === 'linux' && a === 'arm64') return 'rtk-aarch64-unknown-linux-gnu.tar.gz'
  if (p === 'linux' && a === 'x64') return 'rtk-x86_64-unknown-linux-musl.tar.gz'
  if (p === 'win32' && a === 'x64') return 'rtk-x86_64-pc-windows-msvc.zip'
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

function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'gsd-pi-installer' } })
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  if (!response.body) throw new Error('no response body')
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

async function installRtk() {
  if (RTK_SKIP) {
    printSkip('RTK', 'disabled')
    return
  }

  const assetName = resolveAssetName()
  if (!assetName) {
    printSkip('RTK', `unsupported platform ${platform()}-${arch()}`)
    return
  }

  if (existsSync(managedBinaryPath) && validateRtkBinary(managedBinaryPath)) {
    printStep('RTK', `v${RTK_VERSION} up to date`)
    return
  }

  startSpinner('Installing RTK...                         ')

  const tempRoot = join(managedBinDir, `.rtk-install-${randomUUID().slice(0, 8)}`)
  const archivePath = join(tempRoot, assetName)
  const extractDir = join(tempRoot, 'extract')
  const releaseBase = `https://github.com/${RTK_REPO}/releases/download/v${RTK_VERSION}`

  mkdirSync(tempRoot, { recursive: true })
  mkdirSync(managedBinDir, { recursive: true })

  try {
    const checksumsResponse = await fetch(`${releaseBase}/checksums.txt`, {
      headers: { 'User-Agent': 'gsd-pi-installer' },
    })
    if (!checksumsResponse.ok) throw new Error(`checksums fetch failed (${checksumsResponse.status})`)

    const checksums = parseChecksums(await checksumsResponse.text())
    const expectedSha = checksums.get(assetName)
    if (!expectedSha) throw new Error(`missing checksum for ${assetName}`)

    await downloadToFile(`${releaseBase}/${assetName}`, archivePath)
    const actualSha = sha256File(archivePath)
    if (actualSha !== expectedSha) throw new Error('checksum mismatch')

    mkdirSync(extractDir, { recursive: true })
    if (assetName.endsWith('.zip')) {
      // extract-zip may not be available when running via npx — use tar for .tar.gz
      const extractZip = (await import('extract-zip')).default
      await extractZip(archivePath, { dir: extractDir })
    } else {
      const extractResult = spawnSync('tar', ['xzf', archivePath, '-C', extractDir], {
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (extractResult.error || extractResult.status !== 0) {
        throw new Error(extractResult.error?.message || 'tar extraction failed')
      }
    }

    const extractedBinary = findBinaryRecursively(extractDir, platform() === 'win32' ? 'rtk.exe' : 'rtk')
    if (!extractedBinary) throw new Error('binary not found in archive')

    copyFileSync(extractedBinary, managedBinaryPath)
    if (platform() !== 'win32') chmodSync(managedBinaryPath, 0o755)

    if (!validateRtkBinary(managedBinaryPath)) {
      rmSync(managedBinaryPath, { force: true })
      throw new Error('binary validation failed')
    }

    stopSpinner()
    printStep('RTK installed', `v${RTK_VERSION}`)
  } catch (err) {
    stopSpinner()
    printWarn('RTK', describeFetchError(err))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

// Surface the underlying cause when Node's native fetch throws a generic
// "fetch failed" for pre-response network errors (DNS, connect, TLS,
// socket). Without this, CI logs show only the bare message and every
// network-failure class collapses to a single indistinguishable line.
function describeFetchError(err) {
  const base = err?.message || String(err)
  const cause = err?.cause
  if (!cause) return base
  const code = cause.code || cause.errno
  const causeMsg = cause.message || ''
  const detail = code ? `${code}${causeMsg && causeMsg !== code ? ` — ${causeMsg}` : ''}` : causeMsg
  return detail ? `${base} (${detail})` : base
}

// ── Step: Link workspace packages (postinstall from tarball) ───────────────

function linkWorkspacePackages() {
  const scriptPath = join(packageRoot, 'scripts', 'link-workspace-packages.cjs')
  if (!existsSync(scriptPath)) return

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })

    if (result.status === 0) {
      const stderr = (result.stderr || '').toString()
      const linked = stderr.match(/Linked (\d+)/)?.[1]
      const copied = stderr.match(/Copied (\d+)/)?.[1]
      if (linked || copied) {
        const parts = []
        if (linked) parts.push(`${linked} linked`)
        if (copied) parts.push(`${copied} copied`)
        printStep('Workspace packages', parts.join(', '))
      } else {
        printStep('Workspace packages', 'up to date')
      }
    }
  } catch { /* non-fatal */ }
}

// ── Step: Verify installation ──────────────────────────────────────────────

function verifyInstall(local) {
  let bin = 'gsd'
  if (local) {
    const localBin = resolve(process.cwd(), 'node_modules', '.bin', 'gsd')
    if (existsSync(localBin)) {
      bin = localBin
    } else if (platform() === 'win32' && existsSync(localBin + '.cmd')) {
      bin = localBin + '.cmd'
    }
  }

  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })

  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim()
  }
  return null
}

// ── Prompt helper ──────────────────────────────────────────────────────────

function prompt(question, defaultValue) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(defaultValue)
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue)
    })
  })
}

// ── Main ───────────────────────────────────────────────────────────────────

printBanner()

const isLocal = args.includes('--local') || args.includes('-l')

if (IS_POSTINSTALL) {
  // Running as npm postinstall hook — just do workspace linking + deps
  linkWorkspacePackages()
  await installChromium()
  await installRtk()
} else {
  // Running via npx — full interactive install
  if (isLocal) {
    const ok = await installLocally()
    if (!ok) process.exit(1)
  } else {
    const ok = await installGlobally()
    if (!ok) process.exit(1)
  }

  // Run postinstall steps that npm skipped
  linkWorkspacePackages()
  await installChromium()
  await installRtk()

  // Verify
  const version = verifyInstall(isLocal)
  if (version) {
    printStep('Verified', `gsd v${version}`)
  }
}

process.stdout.write(`\n  ${c.green}Ready.${c.reset} Run: ${c.bold}gsd${c.reset}\n\n`)
