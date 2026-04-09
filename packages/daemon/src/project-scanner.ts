/**
 * Project scanner — discovers projects in configured scan_roots by detecting
 * marker files/directories. Reads one level deep (immediate children only).
 */

import { readdir, stat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { ProjectInfo, ProjectMarker } from './types.js';

// ---------------------------------------------------------------------------
// Marker file → project type mapping
// ---------------------------------------------------------------------------

const MARKER_MAP: ReadonlyMap<string, ProjectMarker> = new Map([
  ['.git', 'git'],
  ['package.json', 'node'],
  ['.gsd', 'gsd'],
  ['Cargo.toml', 'rust'],
  ['pyproject.toml', 'python'],
  ['go.mod', 'go'],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan configured roots for project directories.
 *
 * Behaviour:
 * - Reads immediate children of each root (1 level deep, not recursive)
 * - Skips hidden directories (starting with `.`) and `node_modules`
 * - Skips missing roots and permission-denied entries gracefully
 * - Detects markers via MARKER_MAP; directories with no markers are excluded
 * - Results are sorted alphabetically by name
 * - lastModified is the most recent mtime among detected marker files/dirs
 */
export async function scanForProjects(scanRoots: string[]): Promise<ProjectInfo[]> {
  const results: ProjectInfo[] = [];

  for (const root of scanRoots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      // Missing root or permission error — skip gracefully
      continue;
    }

    for (const entry of entries) {
      // Skip hidden directories and node_modules
      if (entry.startsWith('.') || entry === 'node_modules') continue;

      const entryPath = join(root, entry);

      // Must be a directory
      let entryStat;
      try {
        entryStat = await stat(entryPath);
      } catch {
        // Permission error or disappeared entry — skip
        continue;
      }
      if (!entryStat.isDirectory()) continue;

      // Detect markers
      const markers: ProjectMarker[] = [];
      let latestMtime = 0;

      for (const [markerFile, markerType] of MARKER_MAP) {
        const markerPath = join(entryPath, markerFile);
        try {
          const markerStat = await stat(markerPath);
          markers.push(markerType);
          if (markerStat.mtimeMs > latestMtime) {
            latestMtime = markerStat.mtimeMs;
          }
        } catch {
          // Marker doesn't exist — not an error
        }
      }

      // Only include directories with at least one marker
      if (markers.length === 0) continue;

      results.push({
        name: basename(entryPath),
        path: entryPath,
        markers,
        lastModified: latestMtime,
      });
    }
  }

  // Sort alphabetically by name
  results.sort((a, b) => a.name.localeCompare(b.name));

  return results;
}
