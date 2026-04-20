import { DefaultResourceLoader, sortExtensionPaths } from '@gsd/pi-coding-agent'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
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
// Use dist/resources only if it has the full expected structure.
// A partial build (tsc without copy-resources) creates dist/resources/extensions/
// but not agents/ or skills/, causing initResources to sync from an incomplete source.
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
  /**
   * Root-level files installed in extensions/ by this GSD version.
   * Used on the next upgrade to detect and prune files that were removed or
   * moved into a subdirectory, preventing orphaned non-extension files from
   * causing extension load errors.
   */
  installedExtensionRootFiles?: string[]
  /**
   * Subdirectory extension names installed in extensions/ by this GSD version.
   * Used on the next upgrade to detect and prune subdirectory extensions that
   * were removed from the bundle.
   */
  installedExtensionDirs?: string[]
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
  // Record root-level files and subdirectory extension names currently in the
  // bundled extensions source so that future upgrades can detect and prune any
  // that get removed or moved.
  let installedExtensionRootFiles: string[] = []
  let installedExtensionDirs: string[] = []
  try {
    if (existsSync(bundledExtensionsDir)) {
      const entries = readdirSync(bundledExtensionsDir, { withFileTypes: true })
      installedExtensionRootFiles = entries
        .filter(e => e.isFile())
        .map(e => e.name)
      installedExtensionDirs = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          // Track directories that are actual extensions — identified by an
          // index.js/index.ts entry point OR an extension-manifest.json (e.g.
          // remote-questions which uses mod.ts instead of index.ts).
          const dirPath = join(bundledExtensionsDir, e.name)
          return existsSync(join(dirPath, 'index.js'))
            || existsSync(join(dirPath, 'index.ts'))
            || existsSync(join(dirPath, 'extension-manifest.json'))
        })
        .map(e => e.name)
    }
  } catch { /* non-fatal */ }

  const manifest: ManagedResourceManifest = {
    gsdVersion: getBundledGsdVersion(),
    syncedAt: Date.now(),
    contentHash: computeResourceFingerprint(),
    installedExtensionRootFiles,
    installedExtensionDirs,
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
 * Creates (or updates) a symlink at agentDir/node_modules pointing to GSD's
 * own node_modules directory.
 *
 * Native ESM `import()` ignores NODE_PATH — it resolves packages by walking
 * up the directory tree from the importing file. Extension files synced to
 * ~/.gsd/agent/extensions/ have no ancestor node_modules, so imports of
 * @gsd/* packages fail. The symlink makes Node's standard resolution find
 * them without requiring every call site to use jiti.
 *
 * Layout differences by install method:
 * - Source/monorepo: packageRoot/node_modules has everything → simple symlink
 * - npm/bun global: deps hoisted to dirname(packageRoot), including @gsd/* → simple symlink
 * - pnpm global: external deps hoisted, but @gsd/* stays in packageRoot/node_modules
 *   → merged directory with symlinks from both roots (#3529, #3564)
 */
function ensureNodeModulesSymlink(agentDir: string): void {
  const agentNodeModules = join(agentDir, 'node_modules')
  const internalNodeModules = join(packageRoot, 'node_modules')
  const hoistedNodeModules = dirname(packageRoot)
  const isGlobalInstall = basename(hoistedNodeModules) === 'node_modules'

  if (!isGlobalInstall) {
    // Source/monorepo: internal node_modules has everything
    reconcileSymlink(agentNodeModules, internalNodeModules)
    return
  }

  // Global install: check if workspace scopes (@gsd/*) are hoisted.
  // npm/bun hoist everything; pnpm keeps workspace packages internal.
  if (!hasMissingWorkspaceScopes(hoistedNodeModules, internalNodeModules)) {
    // Everything is hoisted — simple symlink to parent node_modules
    reconcileSymlink(agentNodeModules, hoistedNodeModules)
    return
  }

  // pnpm-style layout: create a real directory merging both roots
  reconcileMergedNodeModules(agentNodeModules, hoistedNodeModules, internalNodeModules)
}

/** Check if any @gsd* scopes exist in internal but not in hoisted node_modules */
function hasMissingWorkspaceScopes(hoisted: string, internal: string): boolean {
  if (!existsSync(internal)) return false
  try {
    for (const entry of readdirSync(internal, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('@gsd') &&
          !existsSync(join(hoisted, entry.name))) {
        return true
      }
    }
  } catch { /* non-fatal */ }
  return false
}

/** Ensure a symlink at `link` points to `target`, fixing stale/wrong entries */
function reconcileSymlink(link: string, target: string): void {
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) {
      const existing = readlinkSync(link)
      if (existing === target && existsSync(link)) return  // correct and target exists
      unlinkSync(link)
    } else {
      // Real directory (or merged dir from previous pnpm fix) — remove it
      rmSync(link, { recursive: true, force: true })
    }
  } catch {
    // lstatSync throws if path doesn't exist — fine, we'll create below
  }

  try {
    symlinkSync(target, link, 'junction')
  } catch (err) {
    console.error(`[gsd] WARN: Failed to symlink ${link} → ${target}: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Create a real node_modules directory containing symlinks from both the
 * hoisted root (external deps) and internal root (@gsd/* workspace packages).
 * Used for pnpm global installs where @gsd/* isn't hoisted.
 */
function reconcileMergedNodeModules(
  agentNodeModules: string,
  hoisted: string,
  internal: string,
): void {
  // Fast path: if already merged for this packageRoot + same directory contents, skip.
  // The fingerprint includes entry names from both roots so `pnpm add/remove` triggers rebuild.
  const marker = join(agentNodeModules, '.gsd-merged')
  const fingerprint = mergedFingerprint(hoisted, internal)
  try {
    if (existsSync(marker) && readFileSync(marker, 'utf-8').trim() === fingerprint) return
  } catch { /* rebuild */ }

  // Remove any existing symlink or stale merged directory
  try {
    const stat = lstatSync(agentNodeModules)
    if (stat.isSymbolicLink()) {
      unlinkSync(agentNodeModules)
    } else {
      rmSync(agentNodeModules, { recursive: true, force: true })
    }
  } catch { /* doesn't exist */ }

  mkdirSync(agentNodeModules, { recursive: true })

  let linkedCount = 0

  // Symlink entries from the hoisted node_modules (external deps)
  try {
    for (const entry of readdirSync(hoisted, { withFileTypes: true })) {
      // Skip the gsd-pi package itself and dotfiles
      if (entry.name === basename(packageRoot)) continue
      if (entry.name.startsWith('.')) continue
      try { symlinkSync(join(hoisted, entry.name), join(agentNodeModules, entry.name), 'junction'); linkedCount++ } catch { /* skip individual */ }
    }
  } catch (err) {
    console.error(`[gsd] WARN: Failed to read hoisted node_modules at ${hoisted}: ${err instanceof Error ? err.message : err}`)
  }

  // Overlay internal node_modules entries that weren't hoisted.
  // This covers @gsd/* workspace packages AND optional deps like
  // @anthropic-ai/claude-agent-sdk that npm keeps internal.
  try {
    for (const entry of readdirSync(internal, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const link = join(agentNodeModules, entry.name)
      // Replace hoisted symlink with internal version (internal takes precedence)
      try { lstatSync(link); unlinkSync(link) } catch { /* didn't exist — will create below */ }
      try { symlinkSync(join(internal, entry.name), link, 'junction'); linkedCount++ } catch { /* skip individual */ }
    }
  } catch (err) {
    console.error(`[gsd] WARN: Failed to read internal node_modules at ${internal}: ${err instanceof Error ? err.message : err}`)
  }

  // Only stamp marker if we actually linked something — avoids caching a broken state
  if (linkedCount > 0) {
    try { writeFileSync(marker, fingerprint) } catch { /* non-fatal */ }
  }
}

/** Build a cache fingerprint from packageRoot + sorted entry names of both directories */
function mergedFingerprint(hoisted: string, internal: string): string {
  try {
    const h = readdirSync(hoisted).sort().join(',')
    const i = readdirSync(internal).sort().join(',')
    return `${packageRoot}\n${h}\n${i}`
  } catch {
    return packageRoot  // fallback: at least invalidate on version change
  }
}

/**
 * Prune root-level extension files that were installed by a previous GSD version
 * but have since been removed or relocated to a subdirectory.
 *
 * Two strategies:
 * 1. Manifest-based (preferred): the manifest records which root files were installed
 *    last time; any that are no longer in the current bundle are deleted.
 * 2. Known-stale fallback: for upgrades from versions before manifest tracking,
 *    explicitly delete files known to have been moved (e.g. env-utils.js → gsd/).
 */
function pruneRemovedBundledExtensions(
  manifest: ManagedResourceManifest | null,
  agentDir: string,
): void {
  const extensionsDir = join(agentDir, 'extensions')
  if (!existsSync(extensionsDir)) return

  // Current bundled root-level files (what the new version provides)
  const currentSourceFiles = new Set<string>()
  // Current bundled subdirectory extensions
  const currentSourceDirs = new Set<string>()
  try {
    if (existsSync(bundledExtensionsDir)) {
      for (const e of readdirSync(bundledExtensionsDir, { withFileTypes: true })) {
        if (e.isFile()) currentSourceFiles.add(e.name)
        if (e.isDirectory()) currentSourceDirs.add(e.name)
      }
    }
  } catch { /* non-fatal */ }

  const removeFileIfStale = (fileName: string) => {
    if (currentSourceFiles.has(fileName)) return  // still in bundle, not stale
    const stale = join(extensionsDir, fileName)
    try { if (existsSync(stale)) rmSync(stale, { force: true }) } catch { /* non-fatal */ }
  }

  const removeDirIfStale = (dirName: string) => {
    if (currentSourceDirs.has(dirName)) return  // still in bundle, not stale
    const stale = join(extensionsDir, dirName)
    try { if (existsSync(stale)) rmSync(stale, { recursive: true, force: true }) } catch { /* non-fatal */ }
  }

  if (manifest?.installedExtensionRootFiles) {
    // Manifest-based: remove previously-installed root files that are no longer bundled
    for (const prevFile of manifest.installedExtensionRootFiles) {
      removeFileIfStale(prevFile)
    }
  }

  if (manifest?.installedExtensionDirs) {
    // Manifest-based: remove previously-installed subdirectory extensions that are no longer bundled
    for (const prevDir of manifest.installedExtensionDirs) {
      removeDirIfStale(prevDir)
    }
  }

  // Sweep-based: also remove any installed extension subdirectory not in the current bundle,
  // even if it was never tracked in the manifest (e.g. installed by a pre-manifest version).
  try {
    if (existsSync(extensionsDir)) {
      for (const e of readdirSync(extensionsDir, { withFileTypes: true })) {
        if (e.isDirectory()) removeDirIfStale(e.name)
      }
    }
  } catch { /* non-fatal */ }

  // Always remove known stale files regardless of manifest state.
  // These were installed by pre-manifest versions so they may not appear in
  // installedExtensionRootFiles even when a manifest exists.
  // env-utils.js was moved from extensions/ root → gsd/ in v2.39.x (#1634)
  removeFileIfStale('env-utils.js')
}

/**
 * Syncs all bundled resources to agentDir (~/.gsd/agent/) on every launch.
 *
 * - extensions/ → ~/.gsd/agent/extensions/   (overwrite when version changes)
 * - agents/     → ~/.gsd/agent/agents/        (overwrite when version changes)
 * - GSD-WORKFLOW.md → ~/.gsd/agent/GSD-WORKFLOW.md (fallback for env var miss)
 *
 * Skills are NOT synced here. They are installed by the user via the
 * skills.sh CLI (`npx skills add <repo>`) into ~/.agents/skills/ — the
 * industry-standard Agent Skills ecosystem directory.
 *
 * Skips the copy when the managed-resources.json version matches the current
 * GSD version, avoiding ~128ms of synchronous cpSync on every startup.
 * After `npm update -g @glittercowboy/gsd`, versions will differ and the
 * copy runs once to land the new resources.
 *
 * Inspectable: `ls ~/.gsd/agent/extensions/`
 */
export function initResources(agentDir: string, skillsDir: string = join(homedir(), '.agents', 'skills')): void {
  mkdirSync(agentDir, { recursive: true })

  const currentVersion = getBundledGsdVersion()
  const manifest = readManagedResourceManifest(agentDir)
  const extensionsDir = join(agentDir, 'extensions')

  // Always prune root-level extension files that were removed from the bundle.
  // This is cheap (a few existence checks + at most one rmSync) and must run
  // unconditionally so that stale files left by a previous version are cleaned
  // up even when the version/hash match causes the full sync to be skipped.
  pruneRemovedBundledExtensions(manifest, agentDir)
  pruneStaleSiblingFiles(bundledExtensionsDir, extensionsDir)

  // Ensure ~/.gsd/agent/node_modules symlinks to GSD's node_modules on EVERY
  // launch, not just during resource syncs. A stale/broken symlink makes ALL
  // extensions fail to resolve @gsd/* packages, rendering GSD non-functional.
  ensureNodeModulesSymlink(agentDir)

  // Migrate legacy skills on every launch (not gated by manifest) so that
  // partial-failure retries don't wait for a version bump.
  migrateSkillsToEcosystemDir(agentDir)

  // Skip the full copy when both version AND content fingerprint match.
  // Version-only checks miss same-version content changes (npm link dev workflow,
  // hotfixes within a release). The content hash catches those at ~1ms cost.
  if (manifest && manifest.gsdVersion === currentVersion) {
    // Version matches — check content fingerprint for same-version staleness.
    const currentHash = computeResourceFingerprint()
    const hasStaleExtensionFiles = hasStaleCompiledExtensionSiblings(extensionsDir, bundledExtensionsDir)
    if (manifest.contentHash && manifest.contentHash === currentHash && !hasStaleExtensionFiles) {
      return
    }
  }

  // Sync bundled resources — overwrite so updates land on next launch.

  syncResourceDir(bundledExtensionsDir, join(agentDir, 'extensions'))
  syncResourceDir(join(resourcesDir, 'agents'), join(agentDir, 'agents'))
  syncResourceDir(join(resourcesDir, 'skills'), skillsDir)

  // Sync GSD-WORKFLOW.md to agentDir as a fallback for when GSD_WORKFLOW_PATH
  // env var is not set (e.g. fork/dev builds, alternative entry points).
  const workflowSrc = join(resourcesDir, 'GSD-WORKFLOW.md')
  if (existsSync(workflowSrc)) {
    try { copyFileSync(workflowSrc, join(agentDir, 'GSD-WORKFLOW.md')) } catch { /* non-fatal */ }
  }

  // Ensure all newly copied files are owner-writable so the next run can
  // overwrite them (covers extensions, agents, and skills in one walk).
  makeTreeWritable(agentDir)

  writeManagedResourceManifest(agentDir)
  ensureRegistryEntries(join(agentDir, 'extensions'))
}

// ─── Legacy Skill Migration ──────────────────────────────────────────────────────

/**
 * One-time migration: copy user-customized skills from the old
 * ~/.gsd/agent/skills/ directory into ~/.agents/skills/.
 *
 * The migration is conservative:
 *  - Only skill directories containing a SKILL.md are considered.
 *  - Copies, does not move — the old directory stays intact so downgrading
 *    to a pre-migration GSD version still works.
 *  - Collision-safe — if a skill name already exists in the target, the
 *    existing ecosystem skill wins (user may have already installed a newer
 *    version via skills.sh).
 *  - Writes a `.migrated-to-agents` marker inside the legacy directory so
 *    the migration runs at most once.
 */
function migrateSkillsToEcosystemDir(agentDir: string): void {
  const legacyDir = join(agentDir, 'skills')
  const markerPath = join(legacyDir, '.migrated-to-agents')

  // Already migrated or no legacy dir — nothing to do
  if (!existsSync(legacyDir)) return

  // Atomic marker check — 'wx' fails if file already exists, preventing races
  // when two GSD processes start simultaneously.
  let markerFd: number
  try {
    markerFd = openSync(markerPath, 'wx')
  } catch {
    return // marker already exists (another process won the race, or already migrated)
  }

  try {
    const ecosystemDir = join(homedir(), '.agents', 'skills')
    mkdirSync(ecosystemDir, { recursive: true })

    const entries = readdirSync(legacyDir, { withFileTypes: true })
    let migrated = 0
    let candidates = 0
    for (const entry of entries) {
      // Handle both real directories and symlinks pointing to directories
      const isDir = entry.isDirectory()
      const isSymlink = entry.isSymbolicLink()
      if (!isDir && !isSymlink) continue

      const sourcePath = join(legacyDir, entry.name)

      // For symlinks, verify the target is a directory
      if (isSymlink) {
        try {
          const stat = statSync(sourcePath)
          if (!stat.isDirectory()) continue
        } catch {
          continue // broken symlink — skip
        }
      }

      const skillMd = join(sourcePath, 'SKILL.md')
      if (!existsSync(skillMd)) continue

      const target = join(ecosystemDir, entry.name)
      if (existsSync(target)) continue // ecosystem version wins

      candidates++
      try {
        if (isSymlink) {
          // Recreate the symlink in the ecosystem directory using an absolute
          // target. Relative symlinks would resolve from the new parent dir
          // (~/.agents/skills/) instead of the original (~/.gsd/agent/skills/),
          // pointing to the wrong location.
          const rawTarget = readlinkSync(sourcePath)
          const absTarget = resolve(dirname(sourcePath), rawTarget)
          symlinkSync(absTarget, target)
        } else {
          cpSync(sourcePath, target, { recursive: true })
        }
        migrated++
      } catch {
        // non-fatal — skip this skill
      }
    }

    // If any skills failed to copy, remove the marker so migration retries
    // on the next launch.  This keeps the legacy dir as fallback until every
    // skill has been successfully migrated.
    if (migrated < candidates) {
      try { closeSync(markerFd); markerFd = -1 } catch { /* non-fatal */ }
      try { unlinkSync(markerPath) } catch { /* non-fatal */ }
      return
    }

    // Write migration info to the marker
    try { writeFileSync(markerFd, `Migrated ${migrated} skill(s) to ${ecosystemDir} on ${new Date().toISOString()}\n`) } catch { /* non-fatal */ }
  } catch {
    // can't create ecosystem dir or read legacy dir — close fd first (required on Windows
    // where unlinkSync fails on open handles), then remove marker so we retry next launch
    try { closeSync(markerFd); markerFd = -1 } catch { /* non-fatal */ }
    try { unlinkSync(markerPath) } catch { /* non-fatal */ }
  } finally {
    if (markerFd !== -1) { try { closeSync(markerFd) } catch { /* non-fatal */ } }
  }
}

export function hasStaleCompiledExtensionSiblings(extensionsDir: string, sourceDir: string = bundledExtensionsDir): boolean {
  if (!existsSync(extensionsDir)) return false
  const sourceFiles = existsSync(sourceDir)
    ? new Set(
        readdirSync(sourceDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name),
      )
    : new Set<string>()
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.js')) continue

    const siblingName = entry.name.endsWith('.ts')
      ? entry.name.replace(/\.ts$/, '.js')
      : entry.name.replace(/\.js$/, '.ts')

    if (!existsSync(join(extensionsDir, siblingName))) continue
    if (sourceFiles.has(entry.name) && sourceFiles.has(siblingName)) continue
    if (sourceFiles.has(entry.name) || sourceFiles.has(siblingName)) {
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
    bundledExtensionKeys: bundledKeys,
    extensionPathsTransform: (paths: string[]) => {
      // 1. Filter community extensions through the GSD registry
      const filteredPaths = paths.filter((entryPath) => {
        const manifest = readManifestFromEntryPath(entryPath)
        if (!manifest) return true // no manifest = always load
        return isExtensionEnabled(registry, manifest.id)
      })

      // 2. Sort in topological dependency order
      const { sortedPaths, warnings } = sortExtensionPaths(filteredPaths)

      return {
        paths: sortedPaths,
        diagnostics: warnings.map((w) => w.message),
      }
    },
  } as ConstructorParameters<typeof DefaultResourceLoader>[0])
}
