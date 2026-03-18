/**
 * Resource version tracking and stale worktree detection.
 *
 * Staleness detection for managed GSD resources and utilities
 * for escaping stale worktree cwd after milestone teardown.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { loadJsonFileOrNull } from "./json-persistence.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProjectRoot } from "./worktree.js";

// ─── Resource Staleness ───────────────────────────────────────────────────

/**
 * Read the resource version (semver) from the managed-resources manifest.
 * Uses gsdVersion instead of syncedAt so that launching a second session
 * doesn't falsely trigger staleness (#804).
 */
function isManifestWithVersion(data: unknown): data is { gsdVersion: string } {
  return data !== null && typeof data === "object" && "gsdVersion" in data! && typeof (data as Record<string, unknown>).gsdVersion === "string";
}

export function readResourceVersion(): string | null {
  const agentDir = process.env.GSD_CODING_AGENT_DIR || join(homedir(), ".gsd", "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  const manifest = loadJsonFileOrNull(manifestPath, isManifestWithVersion);
  return manifest?.gsdVersion ?? null;
}

/**
 * Check if managed resources have been updated since session start.
 * Returns a warning message if stale, null otherwise.
 */
export function checkResourcesStale(versionOnStart: string | null): string | null {
  if (versionOnStart === null) return null;
  const current = readResourceVersion();
  if (current === null) return null;
  if (current !== versionOnStart) {
    return "GSD resources were updated since this session started. Restart gsd to load the new code.";
  }
  return null;
}

// ─── Stale Worktree Escape ────────────────────────────────────────────────

/**
 * Detect and escape a stale worktree cwd (#608).
 *
 * After milestone completion + merge, the worktree directory is removed but
 * the process cwd may still point inside `.gsd/worktrees/<MID>/`.
 * When a new session starts, `process.cwd()` is passed as `base` to startAuto
 * and all subsequent writes land in the wrong directory. This function detects
 * that scenario and chdir back to the project root.
 *
 * Returns the corrected base path.
 */
export function escapeStaleWorktree(base: string): string {
  const projectRoot = resolveProjectRoot(base);
  if (projectRoot === base) return base;
  try {
    process.chdir(projectRoot);
  } catch {
    return base;
  }
  return projectRoot;
}

/**
 * Clean stale runtime unit files for completed milestones.
 *
 * After restart, stale runtime/units/*.json from prior milestones can
 * cause deriveState to resume the wrong milestone (#887). Removes files
 * for milestones that have a SUMMARY (fully complete).
 */
export function cleanStaleRuntimeUnits(
  gsdRootPath: string,
  hasMilestoneSummary: (mid: string) => boolean,
): number {
  const runtimeUnitsDir = join(gsdRootPath, "runtime", "units");
  if (!existsSync(runtimeUnitsDir)) return 0;

  let cleaned = 0;
  try {
    for (const file of readdirSync(runtimeUnitsDir)) {
      if (!file.endsWith(".json")) continue;
      const midMatch = file.match(/(M\d+(?:-[a-z0-9]{6})?)/);
      if (!midMatch) continue;
      if (hasMilestoneSummary(midMatch[1])) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch { /* non-fatal */ }
      }
    }
  } catch { /* non-fatal */ }
  return cleaned;
}
