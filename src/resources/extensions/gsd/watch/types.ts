// GSD Watch — Shared types and constants for the watch sidebar module
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/** Metadata stored in the watch lock file for singleton guard + stale detection. */
export interface WatchLockData {
  pid: number;        // renderer process PID
  paneId: string;     // tmux pane ID (e.g., "%12") for stale pane cleanup
  startedAt: string;  // ISO timestamp
  projectRoot: string; // project root path
}

/** Debounce interval for coalescing file-change events (ms). Per D-16, within 300-400ms range. */
export const DEBOUNCE_MS = 300;

/** Glob patterns to ignore inside .planning/ — editor temp/swap files per D-15. */
export const IGNORED_PATTERNS: string[] = [
  "**/.DS_Store",
  "**/*.swp",
  "**/*~",
  "**/*.tmp",
  "**/.gsd-watch.lock",
];

/** Lock file name for watch singleton guard. Placed in .gsd/ to avoid feedback loop. */
export const WATCH_LOCK_FILE = "watch.lock";

// ─── Tree Model Types (Phase 3: Core Renderer) ─────────────────────────────

/** Status of a tree node: done, active, pending, or blocked. Per D-09. */
export type NodeStatus = "done" | "active" | "pending" | "blocked";

/** A single plan within a phase. */
export interface PlanNode {
  id: string;          // e.g. "03-01"
  label: string;       // derived from filename, e.g. "Plan 01"
  status: NodeStatus;
  hasSummary: boolean;
}

/** A phase containing plans and lifecycle badges. */
export interface PhaseNode {
  number: number;       // numeric prefix, e.g. 3
  dirName: string;      // e.g. "03-core-renderer"
  label: string;        // humanized, e.g. "3. Core Renderer" (per D-03)
  status: NodeStatus;
  badges: boolean[];    // 7 booleans: [CONTEXT, RESEARCH, UI-SPEC, PLAN, SUMMARY, VERIFICATION, HUMAN-UAT] (per D-05)
  plans: PlanNode[];
}

/** Root node: a milestone containing phases. */
export interface MilestoneNode {
  label: string;        // e.g. "v1.1 — GSD Watch" from PROJECT.md or ROADMAP.md
  status: NodeStatus;   // worst-case roll-up from phases (per D-11)
  phases: PhaseNode[];
}
