/**
 * context-tracker.ts — Unified source of truth for project root and port state.
 *
 * Three separate module-level variables previously tracked overlapping
 * "project root" concepts:
 *   - auto-worktree.ts: `originalBase`
 *   - worktree-command.ts: `originalCwd`
 *   - auto/session.ts: `AutoSession.originalBasePath`
 *
 * This module centralizes that state and adds port state management for the
 * session-port lifecycle. All state is module-private; consumers use exported
 * get/set accessor functions (D013 — ES module live bindings break under
 * jiti's CJS shim).
 *
 * IMPORTANT: This module imports NOTHING from other gsd modules to avoid
 * circular dependencies. It is a leaf node in the import graph.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PortState {
  /** Session file path of the coordinator before porting */
  coordinatorSessionFile: string;
  /** Milestone ID of the worker being ported into */
  portedWorkerMid: string;
  /** ISO timestamp of when the port started */
  portedAt: string;
}

// ─── Module-Private State ────────────────────────────────────────────────────

/** The original project root before any worktree chdir */
let projectRoot: string | null = null;

/** Current port state — non-null when ported into a worker session */
let portState: PortState | null = null;

// ─── Project Root Accessors ──────────────────────────────────────────────────

/**
 * Store the original project root before any worktree chdir.
 * Called by auto-worktree.ts, worktree-command.ts, and auto-start.ts
 * when they set their local "original path" variables.
 */
export function setProjectRoot(path: string): void {
  projectRoot = path;
}

/**
 * Get the original project root.
 * Returns null if no root has been set (not in a worktree).
 */
export function getProjectRoot(): string | null {
  return projectRoot;
}

/**
 * Clear the project root (teardown / return to main tree).
 */
export function clearProjectRoot(): void {
  projectRoot = null;
}

// ─── Port State Accessors ────────────────────────────────────────────────────

/**
 * Set the port state when porting into a worker session.
 */
export function setPortState(state: PortState): void {
  portState = { ...state };
}

/**
 * Get the current port state, or null if not ported.
 */
export function getPortState(): PortState | null {
  return portState ? { ...portState } : null;
}

/**
 * Clear the port state (detach from worker session).
 */
export function clearPortState(): void {
  portState = null;
}

/**
 * Check if the coordinator is currently ported into a worker session.
 */
export function isPortActive(): boolean {
  return portState !== null;
}

/**
 * Get the milestone ID of the currently ported worker, or null.
 */
export function getPortedWorkerId(): string | null {
  return portState?.portedWorkerMid ?? null;
}

// ─── Worktree Detection ─────────────────────────────────────────────────────

/**
 * Check if the current process is in a worktree (cwd differs from project root).
 * Returns false if no project root has been set.
 */
export function isInWorktree(): boolean {
  if (!projectRoot) return false;
  return process.cwd() !== projectRoot;
}

/**
 * Get both paths when in a worktree, or null if not.
 */
export function getWorktreeInfo(): { projectRoot: string; worktreePath: string } | null {
  if (!projectRoot) return null;
  const cwd = process.cwd();
  if (cwd === projectRoot) return null;
  return { projectRoot, worktreePath: cwd };
}

// ─── Test Support ────────────────────────────────────────────────────────────

/**
 * Reset all state for test isolation. Exported for tests only.
 */
export function _resetForTesting(): void {
  projectRoot = null;
  portState = null;
}
