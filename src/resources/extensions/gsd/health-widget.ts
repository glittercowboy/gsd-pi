/**
 * GSD Health Widget — always-on ambient health signal rendered belowEditor.
 *
 * Shows a compact 1-2 line summary: progress score, budget, provider key
 * status, and doctor/environment issue count. Refreshes every 60 seconds.
 * Quiet when everything is healthy; turns amber/red when issues arise.
 *
 * Widget key: "gsd-health", placement: "belowEditor"
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { runProviderChecks, summariseProviderIssues } from "./doctor-providers.js";
import { runEnvironmentChecks } from "./doctor-environment.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { nativeIsRepo, nativeLastCommitEpoch, nativeGetCurrentBranch, nativeCommitSubject } from "./native-git-bridge.js";
import { loadLedgerFromDisk, getProjectTotals } from "./metrics.js";
import { describeNextUnit, estimateTimeRemaining, updateSliceProgressCache } from "./auto-dashboard.js";
import { projectRoot } from "./commands/context.js";
import { deriveState, invalidateStateCache } from "./state.js";
import {
  buildHealthLines,
  detectHealthWidgetProjectState,
  type HealthWidgetData,
} from "./health-widget-core.js";

// ── Data loader ────────────────────────────────────────────────────────────────

function loadHealthWidgetData(basePath: string): HealthWidgetData {
  let budgetCeiling: number | undefined;
  let budgetSpent = 0;
  let providerIssue: string | null = null;
  let environmentErrorCount = 0;
  let environmentWarningCount = 0;
  let lastCommitEpoch: number | null = null;
  let lastCommitMessage: string | null = null;

  const projectState = detectHealthWidgetProjectState(basePath);

  try {
    const prefs = loadEffectiveGSDPreferences();
    budgetCeiling = prefs?.preferences?.budget_ceiling;

    const ledger = loadLedgerFromDisk(basePath);
    if (ledger) {
      const totals = getProjectTotals(ledger.units ?? []);
      budgetSpent = totals.cost;
    }
  } catch { /* non-fatal */ }

  try {
    const providerResults = runProviderChecks();
    providerIssue = summariseProviderIssues(providerResults);
  } catch { /* non-fatal */ }

  try {
    const envResults = runEnvironmentChecks(basePath);
    for (const r of envResults) {
      if (r.status === "error") environmentErrorCount++;
      else if (r.status === "warning") environmentWarningCount++;
    }
  } catch { /* non-fatal */ }

  // ── Last commit info ──
  try {
    if (nativeIsRepo(basePath)) {
      const branch = nativeGetCurrentBranch(basePath);
      const epoch = nativeLastCommitEpoch(basePath, branch || "HEAD");
      if (epoch > 0) {
        lastCommitEpoch = epoch;
        lastCommitMessage = nativeCommitSubject(basePath, branch || "HEAD") || null;
      }
    }
  } catch { /* non-fatal */ }

  return {
    projectState,
    budgetCeiling,
    budgetSpent,
    providerIssue,
    environmentErrorCount,
    environmentWarningCount,
    lastCommitEpoch,
    lastCommitMessage,
    lastRefreshed: Date.now(),
  };
}

// ── Widget init ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Initialize the always-on gsd-health widget (belowEditor).
 * Call once from the extension entry point after context is available.
 */
export function initHealthWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const basePath = projectRoot();

  // String-array fallback — used in RPC mode (factory is a no-op there)
  const initialData = loadHealthWidgetData(basePath);
  ctx.ui.setWidget("gsd-health", buildHealthLines(initialData), { placement: "belowEditor" });

  // Factory-based widget for TUI mode — replaces the string-array above
  ctx.ui.setWidget("gsd-health", (_tui, _theme) => {
    let data = initialData;
    let cachedLines: string[] | undefined;
    let refreshInFlight = false;
    let isDisposed = false;

    const refresh = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        data = loadHealthWidgetData(basePath);
        cachedLines = undefined;
        if (!isDisposed) _tui.requestRender();
      } catch { /* non-fatal */ } finally {
        refreshInFlight = false;
      }
    };

    // Fire first enrichment immediately. requestRender() inside is a no-op
    // if the widget has not yet rendered, so this is safe before factory return.
    void refresh();

    const refreshTimer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    let cachedWidth: number | undefined;
    return {
      render(width: number): string[] {
        if (!cachedLines || cachedWidth !== width) {
          cachedLines = buildHealthLines(data, width);
          cachedWidth = width;
        }
        return cachedLines;
      },
      invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
      dispose(): void {
        isDisposed = true;
        clearInterval(refreshTimer);
      },
    };
  }, { placement: "belowEditor" });
}
