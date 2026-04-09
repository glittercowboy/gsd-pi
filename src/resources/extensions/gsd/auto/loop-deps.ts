/**
 * auto/loop-deps.ts — LoopDeps interface for dependency injection into autoLoop.
 *
 * Leaf node in the import DAG (type-only).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "./session.js";
import type { GSDPreferences } from "../preferences.js";
import type { GSDState } from "../types.js";
import type { SessionLockStatus } from "../session-lock.js";
import type { CloseoutOptions } from "../auto-unit-closeout.js";
import type { PostUnitContext, PreVerificationOpts } from "../auto-post-unit.js";
import type {
  VerificationContext,
  VerificationResult,
} from "../auto-verification.js";
import type { DispatchAction } from "../auto-dispatch.js";
import type { WorktreeResolver } from "../worktree-resolver.js";
import type { CmuxLogLevel } from "../../cmux/index.js";
import type { JournalEntry } from "../journal.js";
import type { MergeReconcileResult } from "../auto-recovery.js";

/**
 * Dependencies injected by the caller (auto.ts startAuto) so autoLoop
 * can access private functions from auto.ts without exporting them.
 */
export interface LoopDeps {
  lockBase: () => string;
  buildSnapshotOpts: (
    unitType: string,
    unitId: string,
  ) => CloseoutOptions & Record<string, unknown>;
  stopAuto: (
    ctx?: ExtensionContext,
    pi?: ExtensionAPI,
    reason?: string,
  ) => Promise<void>;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  clearUnitTimeout: () => void;
  updateProgressWidget: (
    ctx: ExtensionContext,
    unitType: string,
    unitId: string,
    state: GSDState,
  ) => void;
  syncCmuxSidebar: (preferences: GSDPreferences | undefined, state: GSDState) => void;
  logCmuxEvent: (
    preferences: GSDPreferences | undefined,
    message: string,
    level?: CmuxLogLevel,
  ) => void;

  // State and cache functions
  invalidateAllCaches: () => void;
  deriveState: (basePath: string) => Promise<GSDState>;
  rebuildState: (basePath: string) => Promise<void>;
  loadEffectiveGSDPreferences: () =>
    | { preferences?: GSDPreferences }
    | undefined;

  // Pre-dispatch health gate
  preDispatchHealthGate: (
    basePath: string,
  ) => Promise<{ proceed: boolean; reason?: string; fixesApplied: string[] }>;

  // Worktree sync
  syncProjectRootToWorktree: (
    originalBase: string,
    basePath: string,
    milestoneId: string | null,
  ) => void;

  // Resource version guard
  checkResourcesStale: (version: string | null) => string | null;

  // Session lock
  validateSessionLock: (basePath: string) => SessionLockStatus;
  updateSessionLock: (
    basePath: string,
    unitType: string,
    unitId: string,
    sessionFile?: string,
  ) => void;
  handleLostSessionLock: (
    ctx?: ExtensionContext,
    lockStatus?: SessionLockStatus,
  ) => void;

  // Milestone transition functions
  sendDesktopNotification: (
    title: string,
    body: string,
    kind: string,
    category: string,
    projectName?: string,
  ) => void;
  setActiveMilestoneId: (basePath: string, mid: string) => void;
  pruneQueueOrder: (basePath: string, pendingIds: string[]) => void;
  isInAutoWorktree: (basePath: string) => boolean;
  shouldUseWorktreeIsolation: () => boolean;
  mergeMilestoneToMain: (
    basePath: string,
    milestoneId: string,
    roadmapContent: string,
  ) => { pushed: boolean; codeFilesChanged: boolean };
  teardownAutoWorktree: (basePath: string, milestoneId: string) => void;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  captureIntegrationBranch: (
    basePath: string,
    mid: string,
  ) => void;
  getIsolationMode: () => string;
  getCurrentBranch: (basePath: string) => string;
  autoWorktreeBranch: (milestoneId: string) => string;
  resolveMilestoneFile: (
    basePath: string,
    milestoneId: string,
    fileType: string,
  ) => string | null;
  reconcileMergeState: (basePath: string, ctx: ExtensionContext) => MergeReconcileResult;

  // Budget/context/secrets
  getLedger: () => unknown;
  getProjectTotals: (units: unknown) => { cost: number };
  formatCost: (cost: number) => string;
  getBudgetAlertLevel: (pct: number) => number;
  getNewBudgetAlertLevel: (lastLevel: number, pct: number) => number;
  getBudgetEnforcementAction: (enforcement: string, pct: number) => string;
  getManifestStatus: (
    basePath: string,
    mid: string | undefined,
    projectRoot?: string,
  ) => Promise<{ pending: unknown[] } | null>;
  collectSecretsFromManifest: (
    basePath: string,
    mid: string | undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    applied: unknown[];
    skipped: unknown[];
    existingSkipped: unknown[];
  } | null>;

  // Dispatch
  resolveDispatch: (dctx: {
    basePath: string;
    mid: string;
    midTitle: string;
    state: GSDState;
    prefs: GSDPreferences | undefined;
    session?: AutoSession;
  }) => Promise<DispatchAction>;
  runPreDispatchHooks: (
    unitType: string,
    unitId: string,
    prompt: string,
    basePath: string,
  ) => {
    firedHooks: string[];
    action: string;
    prompt?: string;
    unitType?: string;
    model?: string;
  };
  getPriorSliceCompletionBlocker: (
    basePath: string,
    mainBranch: string,
    unitType: string,
    unitId: string,
  ) => string | null;
  getMainBranch: (basePath: string) => string;
  // Unit closeout + runtime records
  closeoutUnit: (
    ctx: ExtensionContext,
    basePath: string,
    unitType: string,
    unitId: string,
    startedAt: number,
    opts?: CloseoutOptions & Record<string, unknown>,
  ) => Promise<void>;
  recordOutcome: (unitType: string, tier: string, success: boolean) => void;
  writeLock: (
    lockBase: string,
    unitType: string,
    unitId: string,
    sessionFile?: string,
  ) => void;
  captureAvailableSkills: () => void;
  ensurePreconditions: (
    unitType: string,
    unitId: string,
    basePath: string,
    state: GSDState,
  ) => void;
  updateSliceProgressCache: (
    basePath: string,
    mid: string,
    sliceId?: string,
  ) => void;

  // Model selection + supervision
  selectAndApplyModel: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    unitType: string,
    unitId: string,
    basePath: string,
    prefs: GSDPreferences | undefined,
    verbose: boolean,
    startModel: { provider: string; id: string } | null,
    retryContext?: { isRetry: boolean; previousTier?: string },
  ) => Promise<{
    routing: { tier: string; modelDowngraded: boolean } | null;
    appliedModel: { provider: string; id: string } | null;
  }>;
  resolveModelId: <T extends { id: string; provider: string }>(
    modelId: string,
    availableModels: T[],
    currentProvider: string | undefined,
  ) => T | undefined;
  startUnitSupervision: (sctx: {
    s: AutoSession;
    ctx: ExtensionContext;
    pi: ExtensionAPI;
    unitType: string;
    unitId: string;
    prefs: GSDPreferences | undefined;
    buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>;
    buildRecoveryContext: () => unknown;
    pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>;
  }) => void;

  // Prompt helpers
  getDeepDiagnostic: (basePath: string) => string | null;
  isDbAvailable: () => boolean;
  reorderForCaching: (prompt: string) => string;

  // Filesystem
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  atomicWriteSync: (path: string, content: string) => void;

  // Git
  GitServiceImpl: new (basePath: string, gitConfig: unknown) => unknown;

  // WorktreeResolver
  resolver: WorktreeResolver;

  // Post-unit processing
  postUnitPreVerification: (
    pctx: PostUnitContext,
    opts?: PreVerificationOpts,
  ) => Promise<"dispatched" | "continue" | "retry">;
  runPostUnitVerification: (
    vctx: VerificationContext,
    pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI) => Promise<void>,
  ) => Promise<VerificationResult>;
  postUnitPostVerification: (
    pctx: PostUnitContext,
  ) => Promise<"continue" | "step-wizard" | "stopped">;

  // Session manager
  getSessionFile: (ctx: ExtensionContext) => string;

  // Journal
  emitJournalEvent: (entry: JournalEntry) => void;
}
