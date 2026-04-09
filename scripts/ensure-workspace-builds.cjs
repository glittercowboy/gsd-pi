#!/usr/bin/env node
/**
 * ensure-workspace-builds.cjs
 *
 * Checks whether workspace packages have been compiled (dist/ exists with
 * index.js) and that the build is not stale (no src/ file newer than dist/).
 * If any are missing or stale, runs the build for those packages.
 *
 * Designed for the postinstall hook so that `npm install` in a fresh clone
 * produces a working runtime without a manual `npm run build` step. Also
 * catches the common case where `git pull` updates package sources but the
 * old dist/ remains, causing TypeScript type errors.
 *
 * Skipped in CI (where the full build pipeline handles this) and when
 * installing as an end-user dependency (no packages/ directory).
 */
const { existsSync, statSync, readdirSync } = require('fs')
const { resolve, join } = require('path')
const { execSync } = require('child_process')

/**
 * Returns the most recent mtime (ms) of any .ts file under dir, recursively.
 * Returns 0 if no .ts files found.
 */
function newestSrcMtime(dir) {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSrcMtime(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

/**
 * Detects workspace packages whose dist/ is missing or stale.
 *
 * Missing dist/index.js is always reported (the package won't work at all).
 *
 * Staleness (src/ newer than dist/) is ONLY checked when a .git directory
 * exists at root — indicating a development clone. In npm tarball installs,
 * file timestamps are unreliable (npm sets all files to a canonical date,
 * but extraction ordering can cause src/ to appear 1-2 seconds newer than
 * dist/). Attempting to rebuild in that scenario is dangerous: devDependencies
 * (including TypeScript) are not installed, and any globally-installed tsc
 * may produce broken output that overwrites the known-good dist/.
 *
 * @param {string} root    Project root directory
 * @param {string[]} packages  Package directory names to check
 * @returns {string[]} Package names that need rebuilding
 */
function detectStalePackages(root, packages) {
  const packagesDir = join(root, 'packages')
  const isDevClone = existsSync(join(root, '.git'))

  const stale = []
  for (const pkg of packages) {
    const distIndex = join(packagesDir, pkg, 'dist', 'index.js')
    if (!existsSync(distIndex)) {
      stale.push(pkg)
      continue
    }
    // Only check src vs dist timestamps in development clones.
    // In npm tarball installs, timestamps are unreliable and rebuilding
    // without devDependencies can corrupt the pre-built dist/ (#2877).
    if (isDevClone) {
      const distMtime = statSync(distIndex).mtimeMs
      const srcMtime = newestSrcMtime(join(packagesDir, pkg, 'src'))
      if (srcMtime > distMtime) {
        stale.push(pkg)
      }
    }
  }
  return stale
}

if (require.main === module) {
  const root = resolve(__dirname, '..')
  const packagesDir = join(root, 'packages')

  // Skip if packages/ doesn't exist (published tarball / end-user install)
  if (!existsSync(packagesDir)) process.exit(0)

  // Skip in CI — the pipeline runs `npm run build` explicitly
  if (process.env.CI === 'true' || process.env.CI === '1') process.exit(0)

  // Workspace packages that need dist/index.js at runtime.
  // Order matters: dependencies must build before dependents.
  const WORKSPACE_PACKAGES = [
    'native',
    'pi-tui',
    'pi-ai',
    'pi-agent-core',
    'pi-coding-agent',
  ]

  const stale = detectStalePackages(root, WORKSPACE_PACKAGES)

  if (stale.length === 0) process.exit(0)

  process.stderr.write(`  Building ${stale.length} workspace package(s) with stale or missing dist/: ${stale.join(', ')}\n`)

  for (const pkg of stale) {
    const pkgDir = join(packagesDir, pkg)
    try {
      // execSync is safe here: the command is a hardcoded string, not user input
      execSync('npm run build', { cwd: pkgDir, stdio: 'pipe' })
      process.stderr.write(`  ✓ ${pkg}\n`)
    } catch (err) {
      process.stderr.write(`  ✗ ${pkg} build failed: ${err.message}\n`)
      // Non-fatal — the user can run `npm run build` manually
    }
  }
}

module.exports = { newestSrcMtime, detectStalePackages }
