#!/usr/bin/env node
/**
 * Rebuild the Next.js web host only when web source files are newer than the
 * staged standalone build. Skips the build when nothing has changed.
 *
 * Also self-heals a missing/incomplete web dependency install so `npm run gsd:web`
 * doesn't fail with bare `next` command-not-found errors.
 *
 * Exit codes:
 *   0 — build was up-to-date or successfully rebuilt
 *   1 — build failed
 */

'use strict'

const { execSync } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

// Skip on Windows — Next.js webpack build hits EPERM scanning system dirs
if (process.platform === 'win32') {
  console.log('[gsd] Web build skipped on Windows.')
  process.exit(0)
}

const root = resolve(__dirname, '..')
const webRoot = join(root, 'web')
// Also watch src/ because api routes import directly from src/web/* and src/resources/*
const srcRoot = join(root, 'src')
const stagedSentinel = join(root, 'dist', 'web', 'standalone', 'server.js')

// Directories inside web/ that are not source and should be ignored for
// staleness comparison.
const IGNORED_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'out', '.cache'])

/**
 * Walk a directory tree, yield the mtime of every file, skipping ignored dirs.
 * Returns the maximum mtime found (ms since epoch), or 0 if nothing found.
 */
function newestMtime(dir) {
  let max = 0
  let stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(join(current, entry.name))
        }
        continue
      }
      try {
        const mt = statSync(join(current, entry.name)).mtimeMs
        if (mt > max) max = mt
      } catch {
        // skip unreadable files
      }
    }
  }
  return max
}

function sentinelMtime() {
  try {
    return statSync(stagedSentinel).mtimeMs
  } catch {
    return 0
  }
}

function hasWebBuildDependencies() {
  return existsSync(join(webRoot, 'node_modules', '.bin', 'next'))
}

function ensureWebBuildDependencies() {
  if (hasWebBuildDependencies()) {
    return
  }

  console.log('[gsd] Web build dependencies are missing or incomplete — running npm --prefix web ci...')
  execSync('npm --prefix web ci', { cwd: root, stdio: 'inherit' })
}

const sourceMtime = Math.max(newestMtime(webRoot), newestMtime(srcRoot))
const builtMtime = sentinelMtime()

if (builtMtime > 0 && builtMtime >= sourceMtime) {
  console.log('[gsd] Web build is up-to-date, skipping rebuild.')
  process.exit(0)
}

if (builtMtime === 0) {
  console.log('[gsd] No staged web build found — building now...')
} else {
  console.log('[gsd] Web/src source has changed since last build — rebuilding...')
}

try {
  ensureWebBuildDependencies()
  execSync('npm run build:web-host', { cwd: root, stdio: 'inherit' })
} catch (err) {
  console.error('[gsd] Web build failed:', err.message)
  process.exit(1)
}
