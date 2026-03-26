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
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, '..', 'src', 'resources')
const dest = resolve(__dirname, '..', 'dist', 'resources')

function sync() {
  // Remove dest first to mirror deletions from src (prevents stale files)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true, force: true })
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
