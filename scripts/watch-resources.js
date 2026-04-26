#!/usr/bin/env node

/**
 * Watch src/resources/ and sync changes to dist/resources/.
 *
 * Runs alongside `tsc --watch` to ensure non-TS resources (prompts, agents,
 * skills, workflow files) are kept in sync with the build output.
 *
 * This solves the `npm link` branch-drift problem: without dist/resources/,
 * `initResources()` reads from src/resources/ which changes with git branch
 * switches, causing stale extensions to be synced to ~/.gsd/agent/ for ALL
 * projects using gsd.
 */

import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, '..', 'src', 'resources')
const dest = resolve(__dirname, '..', 'dist', 'resources')
const SKIP_DIRS = new Set(['tests', '__tests__'])
const SKIP_FILE_RE = /(?:^\.DS_Store$|\.test\.(?:cjs|mjs|js|json|md|py)$|\.spec\.(?:cjs|mjs|js|json|md|py)$)/
const FINGERPRINT_FILE = '.managed-resources-content-hash'

function shouldSkip(entry) {
  if (entry.isDirectory()) {
    return SKIP_DIRS.has(entry.name)
  }
  return SKIP_FILE_RE.test(entry.name)
}

function copyRuntimeResources(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (shouldSkip(entry)) {
      continue
    }

    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)

    if (entry.isDirectory()) {
      copyRuntimeResources(srcPath, destPath)
      continue
    }

    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(srcPath, destPath)
  }
}

function collectFileEntries(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === FINGERPRINT_FILE) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFileEntries(fullPath, root, out)
      continue
    }
    const rel = fullPath.slice(root.length + 1).replaceAll('\\', '/')
    const contentHash = createHash('sha256').update(readFileSync(fullPath)).digest('hex')
    out.push(`${rel}:${contentHash}`)
  }
}

function writeResourceFingerprint(rootDir) {
  const entries = []
  collectFileEntries(rootDir, rootDir, entries)
  entries.sort()
  const hash = createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16)
  writeFileSync(join(rootDir, FINGERPRINT_FILE), `${hash}\n`)
}

function sync() {
  // Remove dest first to mirror deletions from src (prevents stale files)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  copyRuntimeResources(src, dest)
  writeResourceFingerprint(dest)
}

// Initial sync
sync()
process.stderr.write(`[watch-resources] Initial sync done\n`)

// Watch for changes — recursive, debounced.
// fs.watch({ recursive: true }) is supported on macOS and Windows.
// On Linux (Node <20.13) it throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
// Fall back to polling on unsupported platforms.
let timer = null
let fsWatcher = null
let pollInterval = null

const onChange = () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    sync()
    process.stderr.write(`[watch-resources] Synced at ${new Date().toLocaleTimeString()}\n`)
  }, 300)
}

try {
  fsWatcher = watch(src, { recursive: true }, onChange)
} catch {
  // Fallback: poll every 2s (Linux without recursive watch support)
  process.stderr.write(`[watch-resources] fs.watch recursive not supported, falling back to polling\n`)
  pollInterval = setInterval(() => {
    try { sync() } catch {}
  }, 2000)
}

process.on('exit', () => {
  if (timer) clearTimeout(timer)
  if (fsWatcher) fsWatcher.close()
  if (pollInterval) clearInterval(pollInterval)
})

process.stderr.write(`[watch-resources] Watching src/resources/ → dist/resources/\n`)
