import type { PausedSessionMetadata } from "../interrupted-session.js";
import type { StartModel } from "./session.js";

/**
 * Owns only paused-session model metadata.
 *
 * auto.ts decides when pause/resume happens and writes the surrounding
 * paused-session record. This module snapshots, restores, and backfills the
 * model fields inside that record. It deliberately accepts missing fields so
 * paused-session.json files from older GSD versions resume with the current
 * session model as the fallback.
 */
export interface PausedModelSnapshot {
  autoModeStartModel: StartModel | null;
  originalModel: StartModel | null;
}

export interface PausedModelSnapshotTarget {
  autoModeStartModel: StartModel | null;
  originalModelProvider: string | null;
  originalModelId: string | null;
}

export interface SessionModelSnapshot {
  provider: string;
  id: string;
}

export function snapshotPausedModelMetadata(
  state: Pick<PausedModelSnapshotTarget, "autoModeStartModel" | "originalModelProvider" | "originalModelId">,
): Pick<PausedSessionMetadata, "autoModeStartModel" | "originalModelProvider" | "originalModelId"> {
  return {
    autoModeStartModel: state.autoModeStartModel
      ? { ...state.autoModeStartModel }
      : null,
    originalModelProvider: state.originalModelProvider ?? null,
    originalModelId: state.originalModelId ?? null,
  };
}

export function restoreModelSnapshotFromPausedMetadata(
  meta: PausedSessionMetadata | null | undefined,
): PausedModelSnapshot {
  const autoModeStartModel =
    meta?.autoModeStartModel
    && typeof meta.autoModeStartModel.provider === "string"
    && typeof meta.autoModeStartModel.id === "string"
      ? {
          provider: meta.autoModeStartModel.provider,
          id: meta.autoModeStartModel.id,
        }
      : null;

  const originalModel =
    typeof meta?.originalModelProvider === "string"
    && typeof meta?.originalModelId === "string"
      ? {
          provider: meta.originalModelProvider,
          id: meta.originalModelId,
        }
      : null;

  return {
    autoModeStartModel,
    originalModel,
  };
}

export function applyPausedModelSnapshot(
  target: PausedModelSnapshotTarget,
  snapshot: PausedModelSnapshot,
): void {
  if (snapshot.autoModeStartModel) {
    target.autoModeStartModel = { ...snapshot.autoModeStartModel };
  }

  if (snapshot.originalModel) {
    target.originalModelProvider = snapshot.originalModel.provider;
    target.originalModelId = snapshot.originalModel.id;
  }
}

export function backfillMissingPausedModelSnapshot(
  target: PausedModelSnapshotTarget,
  model: SessionModelSnapshot | null | undefined,
): void {
  if (!model) return;

  if (!target.autoModeStartModel) {
    target.autoModeStartModel = {
      provider: model.provider,
      id: model.id,
    };
  }
  if (!target.originalModelProvider) {
    target.originalModelProvider = model.provider;
  }
  if (!target.originalModelId) {
    target.originalModelId = model.id;
  }
}

export type RestorePausedModelResult =
  | { status: "skipped" }
  | { status: "not-found" }
  | { status: "restored" }
  | { status: "set-model-false" }
  | { status: "error"; error: unknown };

export async function attemptRestoreOriginalModelForPausedInteraction(params: {
  originalModelProvider: string | null | undefined;
  originalModelId: string | null | undefined;
  findModel: ((provider: string, id: string) => unknown) | null | undefined;
  setModel: ((model: unknown, options: { persist: false }) => Promise<boolean>) | null | undefined;
}): Promise<RestorePausedModelResult> {
  const {
    originalModelProvider,
    originalModelId,
    findModel,
    setModel,
  } = params;

  if (!originalModelProvider || !originalModelId || !findModel || !setModel) {
    return { status: "skipped" };
  }

  const original = findModel(originalModelProvider, originalModelId);
  if (!original) {
    return { status: "not-found" };
  }

  try {
    const ok = await setModel(original, { persist: false });
    if (!ok) {
      return { status: "set-model-false" };
    }
    return { status: "restored" };
  } catch (error) {
    return {
      status: "error",
      error,
    };
  }
}
