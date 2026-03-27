import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectDetectionKind, ProjectDetectionSignals } from "./bridge-service.ts";
import { detectMonorepo, detectProjectKind } from "./bridge-service.ts";

// ─── Project Discovery ─────────────────────────────────────────────────────

export interface ProjectProgressInfo {
  activeMilestone: string | null;
  activeSlice: string | null;
  phase: string | null;
  milestonesCompleted: number;
  milestonesTotal: number;
}

export interface ProjectMetadata {
  name: string;             // directory name
  path: string;             // absolute path
  kind: ProjectDetectionKind;
  signals: ProjectDetectionSignals;
  lastModified: number;     // mtime epoch ms
  progress?: ProjectProgressInfo | null;
}

/** Excluded directory names when scanning a dev root. */
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

/**
 * Parse a project's `.gsd/STATE.md` for active milestone, slice, phase,
 * and milestone completion tally.
 *
 * Returns `null` when the file is missing or unreadable.
 * Individual fields return `null` when the corresponding line isn't found.
 */
export function readProjectProgress(projectPath: string): ProjectProgressInfo | null {
  try {
    const content = readFileSync(join(projectPath, ".gsd", "STATE.md"), "utf-8");
    const lines = content.split("\n");

    let activeMilestone: string | null = null;
    let activeSlice: string | null = null;
    let phase: string | null = null;
    let milestonesCompleted = 0;
    let milestonesTotal = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("**Active Milestone:**")) {
        activeMilestone = trimmed.replace("**Active Milestone:**", "").trim() || null;
      } else if (trimmed.startsWith("**Active Slice:**")) {
        activeSlice = trimmed.replace("**Active Slice:**", "").trim() || null;
      } else if (trimmed.startsWith("**Phase:**")) {
        phase = trimmed.replace("**Phase:**", "").trim() || null;
      } else if (trimmed.startsWith("- ✅")) {
        milestonesCompleted++;
        milestonesTotal++;
      } else if (trimmed.startsWith("- 🔄")) {
        milestonesTotal++;
      }
    }

    return { activeMilestone, activeSlice, phase, milestonesCompleted, milestonesTotal };
  } catch {
    // File missing or unreadable — no progress available
    return null;
  }
}

/**
 * Scan one directory level under `devRootPath` and return metadata for each
 * discovered project directory. Hidden dirs (starting with `.`), `node_modules`,
 * and `.git` are excluded.
 *
 * **Monorepo detection:** If `devRootPath` itself looks like a project root
 * (has `.git`, `package.json`, monorepo markers like `pnpm-workspace.yaml` /
 * `lerna.json` / `workspaces` in `package.json`), it is returned as a single
 * project entry instead of scanning its children. This prevents monorepo
 * subdirectories from being listed as independent projects.
 *
 * Returns an empty array if `devRootPath` doesn't exist or isn't readable.
 * Results are sorted alphabetically by name.
 */
export function discoverProjects(devRootPath: string, includeProgress?: boolean): ProjectMetadata[] {
  try {
    // ── Check if the root itself is a project/monorepo ──────────────
    // If the devRoot has a .git repo AND looks like a monorepo (pnpm-workspace,
    // lerna, workspaces, etc.) or looks like a standalone project root (has
    // .gsd, or is a recognizable project), return it as a single entry.
    const rootDetection = detectProjectKind(devRootPath);
    if (rootDetection.signals.isMonorepo) {
      const stat = statSync(devRootPath);
      return [{
        name: basename(devRootPath),
        path: devRootPath,
        kind: rootDetection.kind,
        signals: rootDetection.signals,
        lastModified: stat.mtimeMs,
        ...(includeProgress ? { progress: readProjectProgress(devRootPath) } : {}),
      }];
    }

    // ── Standard multi-project scan ─────────────────────────────────
    const entries = readdirSync(devRootPath, { withFileTypes: true });
    const projects: ProjectMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (EXCLUDED_DIRS.has(entry.name)) continue;

      const fullPath = join(devRootPath, entry.name);
      const { kind, signals } = detectProjectKind(fullPath);
      const stat = statSync(fullPath);

      projects.push({
        name: entry.name,
        path: fullPath,
        kind,
        signals,
        lastModified: stat.mtimeMs,
        ...(includeProgress ? { progress: readProjectProgress(fullPath) } : {}),
      });
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  } catch {
    // devRootPath doesn't exist or isn't readable
    return [];
  }
}
