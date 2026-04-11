import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyExpectedArtifact } from "./auto-recovery.js";
import {
  formatCrashInfo,
  isLockProcessAlive,
  readCrashLock,
  type LockData,
} from "./crash-recovery.js";
import { gsdRoot } from "./paths.js";
import {
  synthesizeCrashRecovery,
  type RecoveryBriefing,
} from "./session-forensics.js";
import { deriveState } from "./state.js";
import type { GSDState } from "./types.js";

export type InterruptedSessionClassification =
  | "none"
  | "running"
  | "recoverable"
  | "stale";

export interface PausedSessionMetadata {
  milestoneId?: string;
  worktreePath?: string | null;
  originalBasePath?: string;
  stepMode?: boolean;
  pausedAt?: string;
  sessionFile?: string | null;
  unitType?: string;
  unitId?: string;
  activeEngineId?: string;
  activeRunDir?: string | null;
  autoStartTime?: number;
}

export interface InterruptedSessionAssessment {
  classification: InterruptedSessionClassification;
  lock: LockData | null;
  pausedSession: PausedSessionMetadata | null;
  state: GSDState | null;
  recovery: RecoveryBriefing | null;
  recoveryPrompt: string | null;
  recoveryToolCallCount: number;
  artifactSatisfied: boolean;
  hasResumableDiskState: boolean;
  isBootstrapCrash: boolean;
}

export function readPausedSessionMetadata(
  basePath: string,
): PausedSessionMetadata | null {
  const pausedPath = join(gsdRoot(basePath), "runtime", "paused-session.json");
  if (!existsSync(pausedPath)) return null;

  try {
    return JSON.parse(readFileSync(pausedPath, "utf-8")) as PausedSessionMetadata;
  } catch {
    return null;
  }
}

export function isBootstrapCrashLock(lock: LockData | null): boolean {
  return !!(
    lock &&
    lock.unitType === "starting" &&
    lock.unitId === "bootstrap"
  );
}

export function hasResumableDerivedState(state: GSDState | null): boolean {
  return !!(state?.activeMilestone && state.phase !== "complete");
}

export async function assessInterruptedSession(
  basePath: string,
): Promise<InterruptedSessionAssessment> {
  const pausedSession = readPausedSessionMetadata(basePath);
  const worktreeExists = pausedSession?.worktreePath
    ? existsSync(pausedSession.worktreePath)
    : false;
  const assessmentBasePath = worktreeExists ? pausedSession!.worktreePath! : basePath;
  const rawLock = readCrashLock(basePath);
  const lock = rawLock && rawLock.pid !== process.pid ? rawLock : null;

  if (!lock && !pausedSession) {
    return {
      classification: "none",
      lock: null,
      pausedSession: null,
      state: null,
      recovery: null,
      recoveryPrompt: null,
      recoveryToolCallCount: 0,
      artifactSatisfied: false,
      hasResumableDiskState: false,
      isBootstrapCrash: false,
    };
  }

  if (lock && isLockProcessAlive(lock)) {
    return {
      classification: "running",
      lock,
      pausedSession,
      state: null,
      recovery: null,
      recoveryPrompt: null,
      recoveryToolCallCount: 0,
      artifactSatisfied: false,
      hasResumableDiskState: false,
      isBootstrapCrash: false,
    };
  }

  const isBootstrapCrash = isBootstrapCrashLock(lock);
  const state = await deriveState(assessmentBasePath);
  const hasResumableDiskState = hasResumableDerivedState(state);
  const artifactSatisfied = !!(
    lock &&
    !isBootstrapCrash &&
    verifyExpectedArtifact(lock.unitType, lock.unitId, assessmentBasePath)
  );

  let recovery: RecoveryBriefing | null = null;
  if (lock && !isBootstrapCrash && !artifactSatisfied) {
    recovery = synthesizeCrashRecovery(
      assessmentBasePath,
      lock.unitType,
      lock.unitId,
      lock.sessionFile,
      join(gsdRoot(assessmentBasePath), "activity"),
    );
  }

  const recoveryToolCallCount = recovery?.trace.toolCallCount ?? 0;
  const recoveryPrompt = recoveryToolCallCount > 0 ? recovery!.prompt : null;

  if (isBootstrapCrash) {
    return {
      classification: pausedSession ? "recoverable" : "stale",
      lock,
      pausedSession,
      state,
      recovery,
      recoveryPrompt,
      recoveryToolCallCount,
      artifactSatisfied,
      hasResumableDiskState,
      isBootstrapCrash: true,
    };
  }

  if (!hasResumableDiskState && pausedSession && !lock && recoveryToolCallCount === 0) {
    return {
      classification: "stale",
      lock,
      pausedSession,
      state,
      recovery,
      recoveryPrompt,
      recoveryToolCallCount,
      artifactSatisfied,
      hasResumableDiskState,
      isBootstrapCrash: false,
    };
  }

  if (lock && artifactSatisfied && !hasResumableDiskState && recoveryToolCallCount === 0) {
    return {
      classification: "stale",
      lock,
      pausedSession,
      state,
      recovery,
      recoveryPrompt,
      recoveryToolCallCount,
      artifactSatisfied,
      hasResumableDiskState,
      isBootstrapCrash: false,
    };
  }

  const hasStrongRecoverySignal =
    hasResumableDiskState || recoveryToolCallCount > 0;

  return {
    classification: hasStrongRecoverySignal ? "recoverable" : "stale",
    lock,
    pausedSession,
    state,
    recovery,
    recoveryPrompt,
    recoveryToolCallCount,
    artifactSatisfied,
    hasResumableDiskState,
    isBootstrapCrash: false,
  };
}

export function formatInterruptedSessionSummary(
  assessment: InterruptedSessionAssessment,
): string[] {
  if (assessment.lock) return [formatCrashInfo(assessment.lock)];

  if (assessment.pausedSession?.milestoneId) {
    return [
      `Paused auto-mode session detected for ${assessment.pausedSession.milestoneId}.`,
    ];
  }

  return ["Paused auto-mode session detected."];
}

export function formatInterruptedSessionRunningMessage(
  assessment: InterruptedSessionAssessment,
): string {
  const pid = assessment.lock?.pid;
  return pid
    ? `Another auto-mode session (PID ${pid}) appears to be running.\nStop it with \`kill ${pid}\` before starting a new session.`
    : "Another auto-mode session appears to be running.";
}
