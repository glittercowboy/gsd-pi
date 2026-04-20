#!/usr/bin/env node
// GSD Startup Loader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
import { fileURLToPath } from 'url'
import { dirname, resolve, join, relative, delimiter } from 'path'
import { existsSync, readFileSync, mkdirSync, symlinkSync, cpSync } from 'fs'

// Fast-path: handle --version/-v and --help/-h before importing any heavy
// dependencies. This avoids loading the entire pi-coding-agent barrel import
// (~1s) just to print a version string.
const gsdRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const firstArg = args[0]

// Read package.json once — reused for version, banner, and GSD_VERSION below
let gsdVersion = '0.0.0'
try {
  const pkg = JSON.parse(readFileSync(join(gsdRoot, 'package.json'), 'utf-8'))
  gsdVersion = pkg.version || '0.0.0'
} catch { /* ignore */ }

if (firstArg === '--version' || firstArg === '-v') {
  process.stdout.write(gsdVersion + '\n')
  process.exit(0)
}

if (firstArg === '--help' || firstArg === '-h') {
  const { printHelp } = await import('./help-text.js')
  printHelp(gsdVersion)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Runtime dependency checks — fail fast with clear diagnostics before any
// heavy imports. Reads minimum Node version from the engines field in
// package.json (already parsed above) and verifies git is available.
// ---------------------------------------------------------------------------
{
  const MIN_NODE_MAJOR = 22
  const red = '\x1b[31m'
  const bold = '\x1b[1m'
  const dim = '\x1b[2m'
  const reset = '\x1b[0m'

  // -- Node version --
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10)
  if (nodeMajor < MIN_NODE_MAJOR) {
    process.stderr.write(
      `\n${red}${bold}Error:${reset} GSD requires Node.js >= ${MIN_NODE_MAJOR}.0.0\n` +
      `       You are running Node.js ${process.versions.node}\n\n` +
      `${dim}Install a supported version:${reset}\n` +
      `  nvm install ${MIN_NODE_MAJOR}   ${dim}# if using nvm${reset}\n` +
      `  fnm install ${MIN_NODE_MAJOR}   ${dim}# if using fnm${reset}\n` +
      `  brew install node@${MIN_NODE_MAJOR} ${dim}# macOS Homebrew${reset}\n\n`
    )
    process.exit(1)
  }

  // -- git --
  try {
    const { execFileSync } = await import('child_process')
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    process.stderr.write(
      `\n${red}${bold}Error:${reset} GSD requires git but it was not found on PATH.\n\n` +
      `${dim}Install git:${reset}\n` +
      `  https://git-scm.com/downloads\n\n`
    )
    process.exit(1)
  }
}

import { agentDir, appRoot } from './app-paths.js'
import { applyRtkProcessEnv } from './rtk.js'
import { serializeBundledExtensionPaths } from './bundled-extension-paths.js'
import { discoverExtensionEntryPaths } from './extension-discovery.js'
import { loadRegistry, readManifestFromEntryPath, isExtensionEnabled } from './extension-registry.js'
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

// Print branded banner on first launch (before ~/.gsd/ exists).
// Set GSD_FIRST_RUN_BANNER so cli.ts skips the duplicate welcome screen.
if (!existsSync(appRoot)) {
  const cyan  = '\x1b[36m'
  const green = '\x1b[32m'
  const dim   = '\x1b[2m'
  const reset = '\x1b[0m'
  const colorCyan = (s: string) => `${cyan}${s}${reset}`
  process.stderr.write(
    renderLogo(colorCyan) +
    '\n' +
    `  Get Shit Done ${dim}v${gsdVersion}${reset}\n` +
    `  ${green}Welcome.${reset} Setting up your environment...\n\n`
  )
  process.env.GSD_FIRST_RUN_BANNER = '1'
}

// GSD_CODING_AGENT_DIR — tells pi's getAgentDir() to return ~/.gsd/agent/ instead of ~/.gsd/agent/
process.env.GSD_CODING_AGENT_DIR = agentDir

// GSD_PKG_ROOT — absolute path to gsd-pi package root. Used by deployed extensions
// (e.g. auto.ts resume path) to import modules like resource-loader.js that live
// in the package tree, not in the deployed ~/.gsd/agent/ tree.
process.env.GSD_PKG_ROOT = gsdRoot

// RTK environment — make ~/.gsd/agent/bin visible to all child-process paths,
// not just the bash tool, and force-disable RTK telemetry for GSD-managed use.
applyRtkProcessEnv(process.env)

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
process.env.GSD_VERSION = gsdVersion

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
// Uses the shared discoverExtensionEntryPaths() to scan the bundled resources
// directory, then remaps discovered paths to agentDir (~/.gsd/agent/extensions/)
// where initResources() will sync them.
const bundledExtDir = join(resourcesDir, 'extensions')
const agentExtDir = join(agentDir, 'extensions')
const registry = loadRegistry()
const discoveredExtensionPaths = discoverExtensionEntryPaths(bundledExtDir)
  .map((entryPath) => join(agentExtDir, relative(bundledExtDir, entryPath)))
  .filter((entryPath) => {
    const manifest = readManifestFromEntryPath(entryPath)
    if (!manifest) return true  // no manifest = always load
    return isExtensionEnabled(registry, manifest.id)
  })

process.env.GSD_BUNDLED_EXTENSION_PATHS = serializeBundledExtensionPaths(discoveredExtensionPaths)

// Respect HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars for all outbound requests.
// pi-coding-agent's cli.ts sets this, but GSD bypasses that entry point — so we
// must set it here before any SDK clients are created.
// Lazy-load undici (~200ms) only when proxy env vars are actually set.
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

// Ensure workspace packages are linked (or copied on Windows) before importing
// cli.js (which imports @gsd/*).
// npm postinstall handles this normally, but npx --ignore-scripts skips postinstall.
// On Windows without Developer Mode or admin rights, symlinkSync will throw even for
// 'junction' type — so we fall back to cpSync (a full directory copy) which works
// everywhere without elevated permissions.
const gsdScopeDir = join(gsdNodeModules, '@gsd')
const packagesDir = join(gsdRoot, 'packages')
const wsPackages = ['native', 'pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']
try {
  if (!existsSync(gsdScopeDir)) mkdirSync(gsdScopeDir, { recursive: true })
  for (const pkg of wsPackages) {
    const target = join(gsdScopeDir, pkg)
    const source = join(packagesDir, pkg)
    if (!existsSync(source) || existsSync(target)) continue
    try {
      symlinkSync(source, target, 'junction')
    } catch {
      // Symlink failed (common on Windows without Developer Mode / admin).
      // Fall back to a directory copy — slower on first run but universally works.
      try { cpSync(source, target, { recursive: true }) } catch { /* non-fatal */ }
    }
  }
} catch { /* non-fatal */ }

// Validate critical workspace packages are resolvable. If still missing after the
// symlink+copy attempts, emit a clear diagnostic instead of a cryptic
// ERR_MODULE_NOT_FOUND from deep inside cli.js.
const criticalPackages = ['pi-coding-agent']
const missingPackages = criticalPackages.filter(pkg => !existsSync(join(gsdScopeDir, pkg)))
if (missingPackages.length > 0) {
  const missing = missingPackages.map(p => `@gsd/${p}`).join(', ')
  process.stderr.write(
    `\nError: GSD installation is broken — missing packages: ${missing}\n\n` +
    `This is usually caused by one of:\n` +
    `  • An outdated version installed from npm (run: npm install -g gsd-pi@latest)\n` +
    `  • The packages/ directory was excluded from the installed tarball\n` +
    `  • A filesystem error prevented linking or copying the workspace packages\n\n` +
    `Fix it by reinstalling:\n\n` +
    `  npm install -g gsd-pi@latest\n\n` +
    `If the issue persists, please open an issue at:\n` +
    `  https://github.com/gsd-build/gsd-2/issues\n`
  )
  process.exit(1)
}

// Dynamic import defers ESM evaluation — config.js will see PI_PACKAGE_DIR above
await import('./cli.js')
