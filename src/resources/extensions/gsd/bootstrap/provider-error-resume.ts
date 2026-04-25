import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@gsd/pi-coding-agent";

import { getAutoDashboardData, startAuto, type AutoDashboardData } from "../auto.js";
import { resetTransientRetryState } from "./agent-end-recovery.js";
import { resetSessionTimeoutState } from "../auto/phases.js";

type AutoResumeSnapshot = Pick<AutoDashboardData, "active" | "paused" | "stepMode" | "basePath">;

export interface ProviderErrorResumeDeps {
  getSnapshot(): AutoResumeSnapshot;
  resetTransientRetryState(): void;
  resetSessionTimeoutState(): void;
  startAuto(
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI,
    base: string,
    verboseMode: boolean,
    options?: { step?: boolean },
  ): Promise<void>;
}

const defaultDeps: ProviderErrorResumeDeps = {
  getSnapshot: () => getAutoDashboardData(),
  resetTransientRetryState,
  resetSessionTimeoutState,
  startAuto,
};

export async function resumeAutoAfterProviderDelay(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: ProviderErrorResumeDeps = defaultDeps,
): Promise<"resumed" | "already-active" | "not-paused" | "missing-base"> {
  const snapshot = deps.getSnapshot();

  if (snapshot.active) return "already-active";
  if (!snapshot.paused) return "not-paused";

  if (!snapshot.basePath) {
    ctx.ui.notify(
      "Provider error recovery delay elapsed, but no paused auto-mode base path was available. Leaving auto-mode paused.",
      "warning",
    );
    return "missing-base";
  }

  // Reset retry counters before restarting — without this, counters
  // accumulate across pause/resume cycles and permanently lock out
  // auto-resume after their respective MAX thresholds.
  deps.resetTransientRetryState();
  deps.resetSessionTimeoutState();

  await deps.startAuto(
    ctx as ExtensionCommandContext,
    pi,
    snapshot.basePath,
    false,
    { step: snapshot.stepMode },
  );
  return "resumed";
}
