import { DefaultResourceLoader } from '@gsd/pi-coding-agent'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver } from './update-check.js'
import { discoverExtensionEntryPaths } from './extension-discovery.js'
import { loadRegistry, readManifestFromEntryPath, isExtensionEnabled, ensureRegistryEntries } from './extension-registry.js'

// Resolve resources directory — prefer dist/resources/ (stable, set at build time)
// over src/resources/ (live working tree, changes with git branch).
//
// Why this matters: with `npm link`, src/resources/ points into the gsd-2 repo's
// working tree. Switching branches there changes src/resources/ for ALL projects
// that use gsd — causing stale/broken extensions to be synced to ~/.gsd/agent/.
// dist/resources/ is populated by the build step (`npm run copy-resources`) and
// reflects the built state, not the currently checked-out branch.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distResources = join(packageRoot, 'dist', 'resources')
const srcResources = join(packageRoot, 'src', 'resources')
const resourcesDir = (existsSync(distResources) && existsSync(join(distResources, 'agents')))
  ? distResources
  : srcResources
const bundledExtensionsDir = join(resourcesDir, 'extensions')
const resourceVersionManifestName = 'managed-resources.json'

interface ManagedResourceManifest {
  gsdVersion: string
  syncedAt?: number
  /** Content fingerprint of bundled resources — detects same-version content changes. */
  contentHash?: string
}

export { discoverExtensionEntryPaths } from './extension-discovery.js'

export function getExtensionKey(entryPath: string, extensionsDir: string): string {
  const relPath = relative(extensionsDir, entryPath)
  return relPath.split(/[\\/]/)[0].replace(/\.(?:ts|js)$/, '')
}

function getManagedResourceManifestPath(agentDir: string): string {
  return join(agentDir, resourceVersionManifestName)
}

function getBundledGsdVersion(): string {
  // Prefer GSD_VERSION env var (set once by loader.ts) to avoid re-reading package.json
  if (process.env.GSD_VERSION && process.env.GSD_VERSION !== '0.0.0') {
    return process.env.GSD_VERSION
  }
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'))
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function writeManagedResourceManifest(agentDir: string): void {
  const manifest: ManagedResourceManifest = {
    gsdVersion: getBundledGsdVersion(),
    syncedAt: Date.now(),
    contentHash: computeResourceFingerprint(),
  }
  writeFileSync(getManagedResourceManifestPath(agentDir), JSON.stringify(manifest))
}

export function readManagedResourceVersion(agentDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), 'utf-8')) as ManagedResourceManifest
    return typeof manifest?.gsdVersion === 'string' ? manifest.gsdVersion : null
  } catch {
    return null
  }
}

function readManagedResourceManifest(agentDir: string): ManagedResourceManifest | null {
  try {
    return JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), 'utf-8')) as ManagedResourceManifest
  } catch {
    return null
  }
}

/**
 * Computes a lightweight content fingerprint of the bundled resources directory.
 *
 * Walks all files under resourcesDir and hashes their relative paths + sizes.
 * This catches same-version content changes (npm link dev workflow, hotfixes
 * within a release) without the cost of reading every file's contents.
 *
 * ~1ms for a typical resources tree (~100 files) — just stat calls, no reads.
 */
function computeResourceFingerprint(): string {
  const entries: string[] = []
  collectFileEntries(resourcesDir, resourcesDir, entries)
  entries.sort()
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16)
}

function collectFileEntries(dir: string, root: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFileEntries(fullPath, root, out)
    } else {
      const rel = relative(root, fullPath)
      const size = statSync(fullPath).size
      out.push(`${rel}:${size}`)
    }
  }
}


export function getNewerManagedResourceVersion(agentDir: string, currentVersion: string): string | null {
  const managedVersion = readManagedResourceVersion(agentDir)
  if (!managedVersion) {
    return null
  }
  return compareSemver(managedVersion, currentVersion) > 0 ? managedVersion : null
}

/**
 * Recursively makes all files and directories under dirPath owner-writable.
 *
 * Files copied from the Nix store inherit read-only modes (0444/0555).
 * Calling this before cpSync prevents overwrite failures on subsequent upgrades,
 * and calling it after ensures the next run can overwrite the copies too.
 *
 * Preserves existing permission bits (including executability) and only adds
 * owner-write (and for directories, owner-exec) without widening group/other
 * permissions.
 */
function makeTreeWritable(dirPath: string): void {
  if (!existsSync(dirPath)) return

  // Use lstatSync to avoid following symlinks into immutable filesystems
  // (e.g., Nix store on NixOS/nix-darwin). Symlinks don't carry their own
  // permissions and their targets may be read-only by design (#1298).
  const stats = lstatSync(dirPath)
  if (stats.isSymbolicLink()) return

  const isDir = stats.isDirectory()
  const currentMode = stats.mode & 0o777

  // Ensure owner-write; for directories also ensure owner-exec so they remain traversable.
  let newMode = currentMode | 0o200
  if (isDir) {
    newMode |= 0o100
  }

  if (newMode !== currentMode) {
    try {
      chmodSync(dirPath, newMode)
    } catch {
      // Non-fatal — may fail on read-only filesystems or insufficient permissions
    }
  }

  if (isDir) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = join(dirPath, entry.name)
      makeTreeWritable(entryPath)
    }
  }
}

/**
 * Syncs a single bundled resource directory into the agent directory.
 *
 * 1. Makes the destination writable (handles Nix store read-only copies).
 * 2. Removes destination subdirs that exist in source to clear stale files,
 *    while preserving user-created directories.
 * 3. Copies source into destination.
 * 4. Makes the result writable for the next upgrade cycle.
 */
function syncResourceDir(srcDir: string, destDir: string): void {
  makeTreeWritable(destDir)
  if (existsSync(srcDir)) {
    pruneStaleSiblingFiles(srcDir, destDir)
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const target = join(destDir, entry.name)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      }
    }
    try {
      cpSync(srcDir, destDir, { recursive: true, force: true })
    } catch {
      // Fallback for Windows paths with non-ASCII characters where cpSync
      // fails with the \\?\ extended-length prefix (#1178).
      copyDirRecursive(srcDir, destDir)
    }
    makeTreeWritable(destDir)
  }
}

function pruneStaleSiblingFiles(srcDir: string, destDir: string): void {
  if (!existsSync(destDir)) return

  const sourceFiles = new Set(
    readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  )

  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (sourceFiles.has(entry.name)) continue

    const sourceJsName = entry.name.replace(/\.ts$/, '.js')
    const sourceTsName = entry.name.replace(/\.js$/, '.ts')
    if (sourceFiles.has(sourceJsName) || sourceFiles.has(sourceTsName)) {
      rmSync(join(destDir, entry.name), { force: true })
    }
  }
}

/**
 * Recursive directory copy using copyFileSync — workaround for cpSync failures
 * on Windows paths containing non-ASCII characters (#1178).
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Syncs all bundled resources to agentDir (~/.gsd/agent/) on every launch.
 *
 * - extensions/ → ~/.gsd/agent/extensions/   (overwrite when version changes)
 * - agents/     → ~/.gsd/agent/agents/        (overwrite when version changes)
 * - skills/     → ~/.gsd/agent/skills/        (overwrite when version changes)
 * - GSD-WORKFLOW.md is read directly from bundled path via GSD_WORKFLOW_PATH env var
 *
 * Skips the copy when the managed-resources.json version matches the current
 * GSD version, avoiding ~128ms of synchronous cpSync on every startup.
 * After `npm update -g @glittercowboy/gsd`, versions will differ and the
 * copy runs once to land the new resources.
 *
 * Inspectable: `ls ~/.gsd/agent/extensions/`
 */
export function initResources(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })

  // Skip the full copy when both version AND content fingerprint match.
  // Version-only checks miss same-version content changes (npm link dev workflow,
  // hotfixes within a release). The content hash catches those at ~1ms cost.
  const currentVersion = getBundledGsdVersion()
  const manifest = readManagedResourceManifest(agentDir)
  if (manifest && manifest.gsdVersion === currentVersion) {
    // Version matches — check content fingerprint for same-version staleness.
    const currentHash = computeResourceFingerprint()
    const hasStaleExtensionFiles = hasStaleCompiledExtensionSiblings(join(agentDir, 'extensions'))
    if (manifest.contentHash && manifest.contentHash === currentHash && !hasStaleExtensionFiles) {
      return
    }
  }

  syncResourceDir(bundledExtensionsDir, join(agentDir, 'extensions'))
  syncResourceDir(join(resourcesDir, 'agents'), join(agentDir, 'agents'))
  syncResourceDir(join(resourcesDir, 'skills'), join(agentDir, 'skills'))

  // Ensure all newly copied files are owner-writable so the next run can
  // overwrite them (covers extensions, agents, and skills in one walk).
  makeTreeWritable(agentDir)

  writeManagedResourceManifest(agentDir)
  ensureRegistryEntries(join(agentDir, 'extensions'))
}

export function hasStaleCompiledExtensionSiblings(extensionsDir: string): boolean {
  if (!existsSync(extensionsDir)) return false
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const jsName = entry.name.replace(/\.ts$/, '.js')
    if (existsSync(join(extensionsDir, jsName))) {
      return true
    }
  }
  return false
}

/**
 * Constructs a DefaultResourceLoader that loads extensions from both
 * ~/.gsd/agent/extensions/ (GSD's default) and ~/.pi/agent/extensions/ (pi's default).
 * This allows users to use extensions from either location.
 */
// Cache bundled extension keys at module load — avoids re-scanning the extensions
// directory in buildResourceLoader() (already scanned by loader.ts for env var).
let _bundledExtensionKeys: Set<string> | null = null
function getBundledExtensionKeys(): Set<string> {
  if (!_bundledExtensionKeys) {
    _bundledExtensionKeys = new Set(
      discoverExtensionEntryPaths(bundledExtensionsDir).map((entryPath) => getExtensionKey(entryPath, bundledExtensionsDir)),
    )
  }
  return _bundledExtensionKeys
}

export function buildResourceLoader(agentDir: string): DefaultResourceLoader {
  const registry = loadRegistry()
  const piAgentDir = join(homedir(), '.pi', 'agent')
  const piExtensionsDir = join(piAgentDir, 'extensions')
  const bundledKeys = getBundledExtensionKeys()
  const piExtensionPaths = discoverExtensionEntryPaths(piExtensionsDir)
    .filter((entryPath) => !bundledKeys.has(getExtensionKey(entryPath, piExtensionsDir)))
    .filter((entryPath) => {
      const manifest = readManifestFromEntryPath(entryPath)
      if (!manifest) return true
      return isExtensionEnabled(registry, manifest.id)
    })

  return new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: piExtensionPaths,
  })
}
