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

const stale = []
for (const pkg of WORKSPACE_PACKAGES) {
  const distIndex = join(packagesDir, pkg, 'dist', 'index.js')
  if (!existsSync(distIndex)) {
    stale.push(pkg)
    continue
  }
  const distMtime = statSync(distIndex).mtimeMs
  const srcMtime = newestSrcMtime(join(packagesDir, pkg, 'src'))
  if (srcMtime > distMtime) {
    stale.push(pkg)
  }
}

if (stale.length === 0) process.exit(0)

process.stderr.write(`  Building ${stale.length} workspace package(s) with stale or missing dist/: ${stale.join(', ')}\n`)

for (const pkg of stale) {
  const pkgDir = join(packagesDir, pkg)
  try {
    execSync('npm run build', { cwd: pkgDir, stdio: 'pipe' })
    process.stderr.write(`  ✓ ${pkg}\n`)
  } catch (err) {
    process.stderr.write(`  ✗ ${pkg} build failed: ${err.message}\n`)
    // Non-fatal — the user can run `npm run build` manually
  }
}
