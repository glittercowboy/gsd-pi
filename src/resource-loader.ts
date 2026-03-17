import { DefaultResourceLoader } from '@gsd/pi-coding-agent'
import { homedir } from 'node:os'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver } from './update-check.js'

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
const resourcesDir = existsSync(distResources) ? distResources : srcResources
const bundledExtensionsDir = join(resourcesDir, 'extensions')
const resourceVersionManifestName = 'managed-resources.json'

interface ManagedResourceManifest {
  gsdVersion: string
  syncedAt?: number
}

function isExtensionFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js')
}

function resolveExtensionEntries(dir: string): string[] {
  const packageJsonPath = join(dir, 'package.json')
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      const declared = pkg?.pi?.extensions
      if (Array.isArray(declared)) {
        const resolved = declared
          .filter((entry: unknown): entry is string => typeof entry === 'string')
          .map((entry: string) => resolve(dir, entry))
          .filter((entry: string) => existsSync(entry))
        if (resolved.length > 0) {
          return resolved
        }
      }
    } catch {
      // Ignore malformed manifests and fall back to index.ts/index.js discovery.
    }
  }

  const indexTs = join(dir, 'index.ts')
  if (existsSync(indexTs)) {
    return [indexTs]
  }

  const indexJs = join(dir, 'index.js')
  if (existsSync(indexJs)) {
    return [indexJs]
  }

  return []
}

export function discoverExtensionEntryPaths(extensionsDir: string): string[] {
  if (!existsSync(extensionsDir)) {
    return []
  }

  const discovered: string[] = []
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    const entryPath = join(extensionsDir, entry.name)

    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      discovered.push(entryPath)
      continue
    }

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      discovered.push(...resolveExtensionEntries(entryPath))
    }
  }

  return discovered
}

function getExtensionKey(entryPath: string, extensionsDir: string): string {
  const relPath = relative(extensionsDir, entryPath)
  return relPath.split(/[\\/]/)[0]
}

function getManagedResourceManifestPath(agentDir: string): string {
  return join(agentDir, resourceVersionManifestName)
}

function getBundledGsdVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'))
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return process.env.GSD_VERSION || '0.0.0'
  }
}

function writeManagedResourceManifest(agentDir: string): void {
  const manifest: ManagedResourceManifest = { gsdVersion: getBundledGsdVersion(), syncedAt: Date.now() }
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

export function readManagedResourceSyncedAt(agentDir: string): number | null {
  try {
    const manifest = JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), 'utf-8')) as ManagedResourceManifest
    return typeof manifest?.syncedAt === 'number' ? manifest.syncedAt : null
  } catch {
    return null
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

  const stats = statSync(dirPath)
  const isDir = stats.isDirectory()
  const currentMode = stats.mode & 0o777

  // Ensure owner-write; for directories also ensure owner-exec so they remain traversable.
  let newMode = currentMode | 0o200
  if (isDir) {
    newMode |= 0o100
  }

  if (newMode !== currentMode) {
    chmodSync(dirPath, newMode)
  }

  if (isDir) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = join(dirPath, entry.name)
      makeTreeWritable(entryPath)
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

  // Sync extensions — clean bundled subdirs first to remove stale leftover files,
  // then overwrite so updates land on next launch. Only bundled subdirs are removed;
  // user-created extension directories are preserved.
  const destExtensions = join(agentDir, 'extensions')
  makeTreeWritable(destExtensions)
  for (const entry of readdirSync(bundledExtensionsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const target = join(destExtensions, entry.name)
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    }
  }
  cpSync(bundledExtensionsDir, destExtensions, { recursive: true, force: true })
  makeTreeWritable(destExtensions)

  // Sync agents
  const destAgents = join(agentDir, 'agents')
  const srcAgents = join(resourcesDir, 'agents')
  if (existsSync(srcAgents)) {
    makeTreeWritable(destAgents)
    for (const entry of readdirSync(srcAgents, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const target = join(destAgents, entry.name)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      }
    }
    cpSync(srcAgents, destAgents, { recursive: true, force: true })
    makeTreeWritable(destAgents)
  }

  // Sync skills
  const destSkills = join(agentDir, 'skills')
  const srcSkills = join(resourcesDir, 'skills')
  if (existsSync(srcSkills)) {
    makeTreeWritable(destSkills)
    for (const entry of readdirSync(srcSkills, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const target = join(destSkills, entry.name)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      }
    }
    cpSync(srcSkills, destSkills, { recursive: true, force: true })
    makeTreeWritable(destSkills)
  }

  writeManagedResourceManifest(agentDir)
}

/**
 * Constructs a DefaultResourceLoader that loads extensions from both
 * ~/.gsd/agent/extensions/ (GSD's default) and ~/.pi/agent/extensions/ (pi's default).
 * This allows users to use extensions from either location.
 */
export function buildResourceLoader(agentDir: string): DefaultResourceLoader {
  const piAgentDir = join(homedir(), '.pi', 'agent')
  const piExtensionsDir = join(piAgentDir, 'extensions')
  const bundledKeys = new Set(
    discoverExtensionEntryPaths(bundledExtensionsDir).map((entryPath) => getExtensionKey(entryPath, bundledExtensionsDir)),
  )
  const piExtensionPaths = discoverExtensionEntryPaths(piExtensionsDir).filter(
    (entryPath) => !bundledKeys.has(getExtensionKey(entryPath, piExtensionsDir)),
  )

  return new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: piExtensionPaths,
  })
}
