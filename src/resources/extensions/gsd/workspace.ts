// GSD-2 + Workspace handle: single source of truth for path resolution per milestone

import { join, resolve } from "node:path";
import { type GsdPathContract, resolveGsdPathContract, normalizeRealPath } from "./paths.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";

export type GsdWorkspaceMode = "project" | "worktree";

export interface GsdWorkspace {
  readonly projectRoot: string;          // realpath-normalized absolute
  readonly worktreeRoot: string | null;  // realpath-normalized absolute, null when no worktree
  readonly mode: GsdWorkspaceMode;
  readonly contract: GsdPathContract;    // pre-resolved, frozen
  readonly identityKey: string;          // canonical key (realpath of projectRoot) for dedup/cache
  readonly lockRoot: string;             // where auto.lock and {MID}-META.json live (always projectRoot)
}

export interface MilestoneScope {
  readonly workspace: GsdWorkspace;
  readonly milestoneId: string;
  // path methods:
  readonly contextFile: () => string;
  readonly roadmapFile: () => string;
  readonly stateFile: () => string;
  readonly dbPath: () => string;
  readonly milestoneDir: () => string;
  readonly metaJson: () => string;       // {MID}-META.json on lockRoot
}

function tryRealpath(p: string): string {
  return normalizeRealPath(p);
}

/**
 * Create an immutable GsdWorkspace handle from a raw base path.
 * Resolves both the project root and (when applicable) the worktree root,
 * normalizes them via realpath, and freezes the result.
 */
export function createWorkspace(rawBasePath: string): GsdWorkspace {
  const resolvedBase = resolve(rawBasePath);
  const isWorktree = isGsdWorktreePath(resolvedBase);

  const projectRootRaw = resolveWorktreeProjectRoot(resolvedBase);
  const projectRoot = tryRealpath(resolve(projectRootRaw));

  const worktreeRoot = isWorktree ? tryRealpath(resolvedBase) : null;

  // Derive a canonical base from the already-realpath-normalized paths so that
  // resolveGsdPathContract always receives a canonical path. Using the raw
  // resolvedBase here can produce a non-canonical projectGsd when the input
  // path contains symlinks, causing contract.projectGsd to diverge from the
  // realpath-normalized projectRoot / identityKey.
  const canonicalBase = isWorktree ? (worktreeRoot ?? resolvedBase) : projectRoot;
  const contract = Object.freeze(resolveGsdPathContract(canonicalBase));

  const identityKey = tryRealpath(projectRoot);

  const mode: GsdWorkspaceMode = isWorktree ? "worktree" : "project";

  const workspace: GsdWorkspace = Object.freeze({
    projectRoot,
    worktreeRoot,
    mode,
    contract,
    identityKey,
    lockRoot: projectRoot,
  });

  return workspace;
}

/**
 * Bind a milestoneId to a workspace, producing an immutable MilestoneScope
 * with path-returning closures that resolve via the authoritative projectGsd.
 *
 * All milestone-content paths route to contract.projectGsd (canonical),
 * since that is the authoritative source of truth regardless of worktree mode.
 */
export function scopeMilestone(workspace: GsdWorkspace, milestoneId: string): MilestoneScope {
  const { contract } = workspace;
  const gsd = contract.projectGsd;

  const scope: MilestoneScope = Object.freeze({
    workspace,
    milestoneId,
    contextFile: () => join(gsd, "milestones", milestoneId, `${milestoneId}-CONTEXT.md`),
    roadmapFile: () => join(gsd, "milestones", milestoneId, `${milestoneId}-ROADMAP.md`),
    stateFile: () => join(gsd, "STATE.md"),
    dbPath: () => contract.projectDb,
    milestoneDir: () => join(gsd, "milestones", milestoneId),
    metaJson: () => join(gsd, `${milestoneId}-META.json`),
  });

  return scope;
}
