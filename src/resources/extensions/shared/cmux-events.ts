// GSD-2 — Shared cmux event channel contracts
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * Neutral event channel module for gsd<->cmux IPC.
 * Both gsd and cmux import from here — neither imports the other directly.
 * Per ADR-006 Phase 0: event-based decoupling.
 */

export const CMUX_CHANNELS = {
  SIDEBAR: "cmux:sidebar",
  LOG: "cmux:log",
  LIFECYCLE: "cmux:lifecycle",
} as const;

/** Migrated from cmux/index.ts (D-07) — shared by both gsd and cmux. */
export type CmuxLogLevel = "info" | "progress" | "success" | "warning" | "error";

// ── Structural types (D-05): cmux defines only what it needs ──

export interface CmuxPreferencesInput {
  cmux?: {
    enabled?: boolean;
    notifications?: boolean;
    sidebar?: boolean;
    splits?: boolean;
    browser?: boolean;
  };
}

export interface CmuxStateInput {
  phase: string;
  activeMilestone?: { id: string };
  activeSlice?: { id: string };
  activeTask?: { id: string };
  progress?: {
    milestones: { done: number; total: number };
    slices?: { done: number; total: number };
    tasks?: { done: number; total: number };
  };
}

// ── Event payloads ──

export interface CmuxSidebarEvent {
  action: "sync" | "clear";
  preferences?: CmuxPreferencesInput;
  state?: CmuxStateInput;
}

export interface CmuxLogEvent {
  preferences?: CmuxPreferencesInput;
  message: string;
  level: CmuxLogLevel;
}

export interface CmuxLifecycleEvent {
  action: "markPromptShown";
}
