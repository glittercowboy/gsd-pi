import { DefaultResourceLoader } from '@gsd/pi-coding-agent'
import { homedir } from 'node:os'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  const manifest: ManagedResourceManifest = { gsdVersion: getBundledGsdVersion() }
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

export function getNewerManagedResourceVersion(agentDir: string, currentVersion: string): string | null {
  const managedVersion = readManagedResourceVersion(agentDir)
  if (!managedVersion) {
    return null
  }
  return compareSemver(managedVersion, currentVersion) > 0 ? managedVersion : null
}

/**
 * Syncs all bundled resources to agentDir (~/.gsd/agent/) on every launch.
 *
 * - extensions/ → ~/.gsd/agent/extensions/   (always overwrite — ensures updates ship on next launch)
 * - agents/     → ~/.gsd/agent/agents/        (always overwrite)
 * - skills/     → ~/.gsd/agent/skills/        (always overwrite)
 * - GSD-WORKFLOW.md is read directly from bundled path via GSD_WORKFLOW_PATH env var
 *
 * Always-overwrite ensures `npm update -g @glittercowboy/gsd` takes effect immediately.
 * User customizations should go in ~/.gsd/agent/extensions/ subdirs with unique names,
 * not by editing the gsd-managed files.
 *
 * Inspectable: `ls ~/.gsd/agent/extensions/`
 */
export function initResources(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })

  // Sync extensions — always overwrite so updates land on next launch
  const destExtensions = join(agentDir, 'extensions')
  cpSync(bundledExtensionsDir, destExtensions, { recursive: true, force: true })

  // Sync agents
  const destAgents = join(agentDir, 'agents')
  const srcAgents = join(resourcesDir, 'agents')
  if (existsSync(srcAgents)) {
    cpSync(srcAgents, destAgents, { recursive: true, force: true })
  }

  // Sync skills — always overwrite so updates land on next launch
  const destSkills = join(agentDir, 'skills')
  const srcSkills = join(resourcesDir, 'skills')
  if (existsSync(srcSkills)) {
    cpSync(srcSkills, destSkills, { recursive: true, force: true })
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
