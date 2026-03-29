import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readManifest, readManifestFromEntryPath } from './extension-registry.js'

function isExtensionFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js')
}

/**
 * Resolves the entry-point file(s) for a single extension directory.
 *
 * 1. If the directory contains a package.json with a `pi` manifest object,
 *    the manifest is authoritative:
 *    - `pi.extensions` array → resolve each entry relative to the directory.
 *    - `pi: {}` (no extensions) → return empty (library opt-out, e.g. cmux).
 * 2. Only when no `pi` manifest exists does it fall back to `index.ts` → `index.js`.
 */
export function resolveExtensionEntries(dir: string): string[] {
  const packageJsonPath = join(dir, 'package.json')
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      if (pkg?.pi && typeof pkg.pi === 'object') {
        // When a pi manifest exists, it is authoritative — don't fall through
        // to index.ts/index.js auto-detection. This allows library directories
        // (like cmux) to opt out by declaring "pi": {} with no extensions.
        const declared = pkg.pi.extensions
        if (!Array.isArray(declared) || declared.length === 0) {
          return []
        }
        return declared
          .filter((entry: unknown): entry is string => typeof entry === 'string')
          .map((entry: string) => resolve(dir, entry))
          .filter((entry: string) => existsSync(entry))
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

/**
 * Discovers all extension entry-point paths under an extensions directory.
 *
 * - Top-level .ts/.js files are treated as standalone extension entry points.
 * - Subdirectories are resolved via `resolveExtensionEntries()` (package.json →
 *   pi.extensions, then index.ts/index.js fallback).
 */
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

/**
 * Merge bundled and installed extension entry paths.
 * Installed extensions with the same manifest ID as a bundled extension take precedence (D-14).
 * Loader stays dumb — receives a pre-merged path list (D-15).
 */
export function mergeExtensionEntryPaths(bundledPaths: string[], installedExtDir: string): string[] {
  if (!existsSync(installedExtDir)) return bundledPaths

  // Build map: manifest ID → entry paths for installed extensions
  const installedById = new Map<string, string[]>()
  for (const entry of readdirSync(installedExtDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(installedExtDir, entry.name)
    const manifest = readManifest(dir)
    const entries = resolveExtensionEntries(dir)
    if (manifest && entries.length > 0) {
      installedById.set(manifest.id, entries)
    }
  }

  if (installedById.size === 0) return bundledPaths

  // Filter bundled paths: skip any whose manifest id is shadowed by installed
  const merged: string[] = []
  for (const entryPath of bundledPaths) {
    const manifest = readManifestFromEntryPath(entryPath)
    if (manifest && installedById.has(manifest.id)) continue // shadowed by installed
    merged.push(entryPath)
  }

  // Append all installed entries
  for (const entries of installedById.values()) {
    merged.push(...entries)
  }

  return merged
}
