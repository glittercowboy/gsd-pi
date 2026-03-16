#!/usr/bin/env node
// GSD Startup Loader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
import { fileURLToPath } from 'url'
import { dirname, resolve, join, delimiter } from 'path'
import { existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from 'fs'

// Fast-path: handle --version/-v and --help/-h before importing any heavy
// dependencies. This avoids loading the entire pi-coding-agent barrel import
// (~1s) just to print a version string.
const gsdRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const firstArg = args[0]

if (firstArg === '--version' || firstArg === '-v') {
  try {
    const pkg = JSON.parse(readFileSync(join(gsdRoot, 'package.json'), 'utf-8'))
    process.stdout.write((pkg.version || '0.0.0') + '\n')
  } catch {
    process.stdout.write('0.0.0\n')
  }
  process.exit(0)
}

if (firstArg === '--help' || firstArg === '-h') {
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(join(gsdRoot, 'package.json'), 'utf-8'))
    version = pkg.version || version
  } catch { /* ignore */ }
  const { printHelp } = await import('./help-text.js')
  printHelp(version)
  process.exit(0)
}

import { agentDir, appRoot } from './app-paths.js'
import { serializeBundledExtensionPaths } from './bundled-extension-paths.js'
import { renderLogo } from './logo.js'

// pkg/ is a shim directory: contains gsd's piConfig (package.json) and pi's
// theme assets (dist/modes/interactive/theme/) without a src/ directory.
// This allows config.js to:
//   1. Read piConfig.name → "gsd" (branding)
//   2. Resolve themes via dist/ (no src/ present → uses dist path)
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pkg')

// MUST be set before any dynamic import of pi SDK fires — this is what config.js
// reads to determine APP_NAME and CONFIG_DIR_NAME
process.env.PI_PACKAGE_DIR = pkgDir
process.env.PI_SKIP_VERSION_CHECK = '1'  // GSD runs its own update check in cli.ts — suppress pi's
process.title = 'gsd'

// Print branded banner on first launch (before ~/.gsd/ exists)
if (!existsSync(appRoot)) {
  const cyan  = '\x1b[36m'
  const green = '\x1b[32m'
  const dim   = '\x1b[2m'
  const reset = '\x1b[0m'
  const colorCyan = (s: string) => `${cyan}${s}${reset}`
  let version = ''
  try {
    const pkgJson = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'))
    version = pkgJson.version ?? ''
  } catch { /* ignore */ }
  process.stderr.write(
    renderLogo(colorCyan) +
    '\n' +
    `  Get Shit Done ${dim}v${version}${reset}\n` +
    `  ${green}Welcome.${reset} Setting up your environment...\n\n`
  )
}

// GSD_CODING_AGENT_DIR — tells pi's getAgentDir() to return ~/.gsd/agent/ instead of ~/.gsd/agent/
process.env.GSD_CODING_AGENT_DIR = agentDir

// NODE_PATH — make gsd's own node_modules available to extensions loaded via jiti.
// Without this, extensions (e.g. browser-tools) can't resolve dependencies like
// `playwright` because jiti resolves modules from pi-coding-agent's location, not gsd's.
// Prepending gsd's node_modules to NODE_PATH fixes this for all extensions.
const gsdNodeModules = join(gsdRoot, 'node_modules')
process.env.NODE_PATH = [gsdNodeModules, process.env.NODE_PATH]
  .filter(Boolean)
  .join(delimiter)
// Force Node to re-evaluate module search paths with the updated NODE_PATH.
// Must happen synchronously before cli.js imports → extension loading.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Module } = await import('module');
(Module as any)._initPaths?.()

// GSD_VERSION — expose package version so extensions can display it
try {
  const gsdPkg = JSON.parse(readFileSync(join(gsdRoot, 'package.json'), 'utf-8'))
  process.env.GSD_VERSION = gsdPkg.version || '0.0.0'
} catch {
  process.env.GSD_VERSION = '0.0.0'
}

// GSD_BIN_PATH — absolute path to this loader (dist/loader.js), used by patched subagent
// to spawn gsd instead of pi when dispatching workflow tasks
process.env.GSD_BIN_PATH = process.argv[1]

// GSD_WORKFLOW_PATH — absolute path to bundled GSD-WORKFLOW.md, used by patched gsd extension
// when dispatching workflow prompts. Prefers dist/resources/ (stable, set at build time)
// over src/resources/ (live working tree) — see resource-loader.ts for rationale.
const distRes = join(gsdRoot, 'dist', 'resources')
const srcRes = join(gsdRoot, 'src', 'resources')
const resourcesDir = existsSync(distRes) ? distRes : srcRes
process.env.GSD_WORKFLOW_PATH = join(resourcesDir, 'GSD-WORKFLOW.md')

// GSD_BUNDLED_EXTENSION_PATHS — dynamically discovered bundled extension entry points.
// Scans the bundled resources directory to find all extensions, then maps paths to
// agentDir (~/.gsd/agent/extensions/) where initResources() will sync them.
//
// Discovery rules (mirroring resource-loader.ts discoverExtensionEntryPaths):
//   - Top-level .ts/.js files → extension entry point
//   - Directories with index.ts or index.js → extension entry point
//   - Directories without either (e.g. shared/, remote-questions/) → skipped
//
// Previously this was a hardcoded list that required manual updates whenever
// extensions were added or removed — causing merge conflicts in forks and
// falling out of sync with what buildResourceLoader() discovers at runtime.
const bundledExtDir = join(resourcesDir, 'extensions')
const agentExtDir = join(agentDir, 'extensions')
const discoveredExtensionPaths: string[] = []

if (existsSync(bundledExtDir)) {
  for (const entry of readdirSync(bundledExtDir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      discoveredExtensionPaths.push(join(agentExtDir, entry.name))
    } else if (entry.isDirectory()) {
      const srcIndex = existsSync(join(bundledExtDir, entry.name, 'index.ts'))
        ? 'index.ts'
        : existsSync(join(bundledExtDir, entry.name, 'index.js'))
          ? 'index.js'
          : null
      if (srcIndex) {
        discoveredExtensionPaths.push(join(agentExtDir, entry.name, srcIndex))
      }
    }
  }
}

process.env.GSD_BUNDLED_EXTENSION_PATHS = serializeBundledExtensionPaths(discoveredExtensionPaths)

// Respect HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars for all outbound requests.
// pi-coding-agent's cli.ts sets this, but GSD bypasses that entry point — so we
// must set it here before any SDK clients are created.
// Lazy-load undici (~200ms) only when proxy env vars are actually set.
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

// Ensure workspace packages are linked before importing cli.js (which imports @gsd/*).
// npm postinstall handles this normally, but npx --ignore-scripts skips postinstall.
const gsdScopeDir = join(gsdNodeModules, '@gsd')
const packagesDir = join(gsdRoot, 'packages')
const wsPackages = ['native', 'pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']
try {
  if (!existsSync(gsdScopeDir)) mkdirSync(gsdScopeDir, { recursive: true })
  for (const pkg of wsPackages) {
    const target = join(gsdScopeDir, pkg)
    const source = join(packagesDir, pkg)
    if (existsSync(source) && !existsSync(target)) {
      try { symlinkSync(source, target, 'junction') } catch { /* non-fatal */ }
    }
  }
} catch { /* non-fatal */ }

// Dynamic import defers ESM evaluation — config.js will see PI_PACKAGE_DIR above
await import('./cli.js')
