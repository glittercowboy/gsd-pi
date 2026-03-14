#!/usr/bin/env node
/**
 * link-workspace-packages.cjs
 *
 * Creates node_modules/@gsd/* symlinks pointing to packages/* directories.
 *
 * During development, npm workspaces creates these automatically. But in the
 * published tarball, workspace packages are shipped under packages/ (via the
 * "files" field) and the @gsd/* imports in compiled code need node_modules/@gsd/*
 * to resolve. This script bridges the gap.
 *
 * Runs as part of postinstall (before any ESM code that imports @gsd/*).
 */
const { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, readdirSync } = require('fs')
const { resolve, join } = require('path')

const root = resolve(__dirname, '..')
const packagesDir = join(root, 'packages')
const nodeModulesGsd = join(root, 'node_modules', '@gsd')

// Map directory names to package names
const packageMap = {
  'native': 'native',
  'pi-agent-core': 'pi-agent-core',
  'pi-ai': 'pi-ai',
  'pi-coding-agent': 'pi-coding-agent',
  'pi-tui': 'pi-tui',
}

// Ensure @gsd scope directory exists
if (!existsSync(nodeModulesGsd)) {
  mkdirSync(nodeModulesGsd, { recursive: true })
}

let linked = 0
for (const [dir, name] of Object.entries(packageMap)) {
  const source = join(packagesDir, dir)
  const target = join(nodeModulesGsd, name)

  if (!existsSync(source)) continue

  // Skip if already correctly linked or is a real directory (bundled)
  if (existsSync(target)) {
    try {
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(target)
        if (resolve(join(nodeModulesGsd, linkTarget)) === source || linkTarget === source) {
          continue // Already correct
        }
        unlinkSync(target) // Wrong target, relink
      } else {
        continue // Real directory (e.g., from bundleDependencies), don't touch
      }
    } catch {
      continue
    }
  }

  try {
    symlinkSync(source, target, 'junction') // junction works on Windows too
    linked++
  } catch {
    // Non-fatal — may fail in read-only environments
  }
}

if (linked > 0) {
  process.stderr.write(`  Linked ${linked} workspace packages\n`)
}
