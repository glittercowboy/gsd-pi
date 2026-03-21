#!/usr/bin/env node
/**
 * ensure-workspace-builds.cjs
 *
 * Checks whether workspace packages have been compiled (dist/ exists with
 * index.js). If any are missing, runs the build for those packages.
 *
 * Designed for the postinstall hook so that `npm install` in a fresh clone
 * produces a working runtime without a manual `npm run build` step.
 *
 * Skipped in CI (where the full build pipeline handles this) and when
 * installing as an end-user dependency (no packages/ directory).
 */
const { existsSync } = require('fs')
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

const missing = []
for (const pkg of WORKSPACE_PACKAGES) {
  const distIndex = join(packagesDir, pkg, 'dist', 'index.js')
  if (!existsSync(distIndex)) {
    missing.push(pkg)
  }
}

if (missing.length === 0) process.exit(0)

process.stderr.write(`  Building ${missing.length} workspace package(s) missing dist/: ${missing.join(', ')}\n`)

for (const pkg of missing) {
  const pkgDir = join(packagesDir, pkg)
  try {
    execSync('npm run build', { cwd: pkgDir, stdio: 'pipe' })
    process.stderr.write(`  ✓ ${pkg}\n`)
  } catch (err) {
    process.stderr.write(`  ✗ ${pkg} build failed: ${err.message}\n`)
    // Non-fatal — the user can run `npm run build` manually
  }
}
