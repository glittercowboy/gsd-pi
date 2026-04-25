// GSD2 — Ecosystem Extension API wrapper
// Wraps pi's ExtensionAPI to expose typed GSD context (phase + active unit)
// to extensions loaded from `./.gsd/extensions/`. The wrapper intercepts only
// `on("before_agent_start", ...)` so GSD can dispatch ecosystem handlers AFTER
// refreshing state — fixing the load-order race where third-party
// `.pi/extensions/` handlers see a stale module-level snapshot (#3338).
//
// SINGLE-SESSION INVARIANT: the module-level `_snapshot` is per-process.
// Worktree or project switches do NOT reload extensions, matching pi's
// `.pi/extensions/` behavior. Only re-launching the CLI rebinds the snapshot.

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionHandler,
} from "@gsd/pi-coding-agent";

// Structural mirror of pi's internal BeforeAgentStartEventResult. The internal
// type is not re-exported from the package root, and constraint #3 forbids
// changes to packages/pi-coding-agent/, so we mirror the public shape here.
// `any` on inner fields keeps assignability bidirectional with pi's stricter
// `Pick<CustomMessage, ...>` shape (CustomMessage is also not re-exported).
// Source of truth: packages/pi-coding-agent/src/core/extensions/types.ts
export interface BeforeAgentStartEventResult {
  message?: {
    customType: string;
    content?: any;
    display?: any;
    details?: any;
  };
  systemPrompt?: string;
}

import type { GSDActiveUnit, GSDState, Phase } from "../types.js";
import { isGSDActive, getCurrentPhase } from "../../shared/gsd-phase-state.js";
import { logWarning } from "../workflow-logger.js";

// ─── Public Interface ───────────────────────────────────────────────────

export interface GSDExtensionAPI extends ExtensionAPI {
  /** Current GSD workflow phase, or null if no project state. */
  getPhase(): Phase | null;
  /** Currently active milestone/slice/task triple, or null if none. */
  getActiveUnit(): GSDActiveUnit | null;
}

export type GSDEcosystemBeforeAgentStartHandler = ExtensionHandler<
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult
>;

// ─── Auto-loop phase mapping ────────────────────────────────────────────

const AUTO_LOOP_PHASE_MAP: Record<string, Phase> = {
  "plan-milestone": "planning",
  "plan-slice": "planning",
  "research": "researching",
  "discuss": "discussing",
  "execute-task": "executing",
  "verify": "verifying",
  "summarize-task": "summarizing",
  "summarize-slice": "summarizing",
  "advance": "advancing",
  "validate-milestone": "validating-milestone",
  "complete-milestone": "completing-milestone",
  "replan-slice": "replanning-slice",
};

/** Exposed for unit tests. Returns null for unknown keys (does NOT default). */
export function mapAutoLoopPhase(raw: string): Phase | null {
  return AUTO_LOOP_PHASE_MAP[raw] ?? null;
}

function resolvePhase(state: GSDState | null): Phase | null {
  if (!state) return null;
  if (isGSDActive()) {
    const raw = getCurrentPhase();
    if (raw != null) {
      const mapped = AUTO_LOOP_PHASE_MAP[raw];
      if (mapped) return mapped;
      logWarning("ecosystem", `unknown auto-loop phase: ${raw}`);
      // FALL THROUGH to state.phase rather than defaulting to "executing".
    }
  }
  return state.phase;
}

function resolveActiveUnit(state: GSDState | null): GSDActiveUnit | null {
  if (!state) return null;
  const m = state.activeMilestone;
  const s = state.activeSlice;
  const t = state.activeTask;
  if (!m || !s || !t) return null;
  return {
    milestoneId: m.id,
    milestoneTitle: m.title,
    sliceId: s.id,
    sliceTitle: s.title,
    taskId: t.id,
    taskTitle: t.title,
  };
}

// ─── Module-level snapshot ──────────────────────────────────────────────

interface Snapshot {
  phase: Phase | null;
  activeUnit: GSDActiveUnit | null;
}

let _snapshot: Snapshot = { phase: null, activeUnit: null };

/** Refresh the snapshot from a freshly derived GSDState (or null on failure). */
export function updateSnapshot(state: GSDState | null): void {
  _snapshot = {
    phase: resolvePhase(state),
    activeUnit: resolveActiveUnit(state),
  };
}

export function getSnapshotPhase(): Phase | null {
  return _snapshot.phase;
}

export function getSnapshotActiveUnit(): GSDActiveUnit | null {
  return _snapshot.activeUnit;
}

/** Test-only: reset the snapshot to its initial empty state. */
export function _resetSnapshot(): void {
  _snapshot = { phase: null, activeUnit: null };
}

// ─── Wrapper factory ────────────────────────────────────────────────────

/**
 * Build a GSDExtensionAPI by manually delegating every ExtensionAPI method
 * to the underlying pi instance, except `on("before_agent_start", ...)`
 * which is captured into `sharedHandlers` for GSD-owned dispatch.
 *
 * Uses `satisfies GSDExtensionAPI` (NOT `as`) so TypeScript catches drift
 * when pi adds new ExtensionAPI methods.
 */
export function createGSDExtensionAPI(
  pi: ExtensionAPI,
  sharedHandlers: GSDEcosystemBeforeAgentStartHandler[],
): GSDExtensionAPI {
  const wrapper = {
    // ── Event subscription (single intercept point) ────────────────────
    on(event: any, handler: any): void {
      if (event === "before_agent_start") {
        sharedHandlers.push(handler as GSDEcosystemBeforeAgentStartHandler);
        return;
      }
      (pi.on as (e: any, h: any) => void)(event, handler);
    },

    // ── Event emission ─────────────────────────────────────────────────
    emitBeforeModelSelect: (...args: Parameters<ExtensionAPI["emitBeforeModelSelect"]>) =>
      pi.emitBeforeModelSelect(...args),
    emitAdjustToolSet: (...args: Parameters<ExtensionAPI["emitAdjustToolSet"]>) =>
      pi.emitAdjustToolSet(...args),
    emitExtensionEvent: (...args: Parameters<ExtensionAPI["emitExtensionEvent"]>) =>
      pi.emitExtensionEvent(...args),

    // ── Tool / command / shortcut / flag registration ──────────────────
    registerTool: ((tool: any) => pi.registerTool(tool)) as ExtensionAPI["registerTool"],
    registerCommand: (...args: Parameters<ExtensionAPI["registerCommand"]>) =>
      pi.registerCommand(...args),
    registerBeforeInstall: (...args: Parameters<ExtensionAPI["registerBeforeInstall"]>) =>
      pi.registerBeforeInstall(...args),
    registerAfterInstall: (...args: Parameters<ExtensionAPI["registerAfterInstall"]>) =>
      pi.registerAfterInstall(...args),
    registerBeforeRemove: (...args: Parameters<ExtensionAPI["registerBeforeRemove"]>) =>
      pi.registerBeforeRemove(...args),
    registerAfterRemove: (...args: Parameters<ExtensionAPI["registerAfterRemove"]>) =>
      pi.registerAfterRemove(...args),
    registerShortcut: (...args: Parameters<ExtensionAPI["registerShortcut"]>) =>
      pi.registerShortcut(...args),
    registerFlag: (...args: Parameters<ExtensionAPI["registerFlag"]>) =>
      pi.registerFlag(...args),
    getFlag: (...args: Parameters<ExtensionAPI["getFlag"]>) => pi.getFlag(...args),

    // ── Message rendering ──────────────────────────────────────────────
    registerMessageRenderer: ((customType: string, renderer: any) =>
      pi.registerMessageRenderer(customType, renderer)) as ExtensionAPI["registerMessageRenderer"],

    // ── Actions ────────────────────────────────────────────────────────
    sendMessage: ((message: any, options?: any) =>
      pi.sendMessage(message, options)) as ExtensionAPI["sendMessage"],
    sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) =>
      pi.sendUserMessage(...args),
    retryLastTurn: () => pi.retryLastTurn(),
    appendEntry: ((customType: string, data?: any) =>
      pi.appendEntry(customType, data)) as ExtensionAPI["appendEntry"],

    // ── Session metadata ───────────────────────────────────────────────
    setSessionName: (...args: Parameters<ExtensionAPI["setSessionName"]>) =>
      pi.setSessionName(...args),
    getSessionName: () => pi.getSessionName(),
    setLabel: (...args: Parameters<ExtensionAPI["setLabel"]>) => pi.setLabel(...args),
    exec: (...args: Parameters<ExtensionAPI["exec"]>) => pi.exec(...args),
    getActiveTools: () => pi.getActiveTools(),
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (...args: Parameters<ExtensionAPI["setActiveTools"]>) =>
      pi.setActiveTools(...args),
    getCommands: () => pi.getCommands(),

    // ── Model & thinking ───────────────────────────────────────────────
    setModel: (...args: Parameters<ExtensionAPI["setModel"]>) => pi.setModel(...args),
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: (...args: Parameters<ExtensionAPI["setThinkingLevel"]>) =>
      pi.setThinkingLevel(...args),

    // ── Provider registration ──────────────────────────────────────────
    registerProvider: (...args: Parameters<ExtensionAPI["registerProvider"]>) =>
      pi.registerProvider(...args),
    unregisterProvider: (...args: Parameters<ExtensionAPI["unregisterProvider"]>) =>
      pi.unregisterProvider(...args),

    // ── Shared event bus (passthrough property) ────────────────────────
    events: pi.events,

    // ── GSD-specific additions ─────────────────────────────────────────
    getPhase: (): Phase | null => _snapshot.phase,
    getActiveUnit: (): GSDActiveUnit | null => _snapshot.activeUnit,
  } satisfies GSDExtensionAPI;

  return wrapper;
}
