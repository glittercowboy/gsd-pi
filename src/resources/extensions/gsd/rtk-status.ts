import type { ExtensionContext } from "@gsd/pi-coding-agent";
import {
  ensureRtkSessionBaseline,
  formatRtkSavingsLabel,
  getRtkSessionSavings,
} from "../shared/rtk-session-stats.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

const STATUS_KEY = "gsd-rtk";
const REFRESH_INTERVAL_MS = 30_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function clearTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function isRtkEnabledInPrefs(): boolean {
  return loadEffectiveGSDPreferences()?.preferences.experimental?.rtk === true;
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (!isRtkEnabledInPrefs()) return;

  const basePath = ctx.cwd;
  const sessionId = ctx.sessionManager.getSessionId();
  ensureRtkSessionBaseline(basePath, sessionId);
  const savings = getRtkSessionSavings(basePath, sessionId);
  ctx.ui.setStatus(STATUS_KEY, formatRtkSavingsLabel(savings) ?? undefined);
}

export function startRtkStatusUpdates(ctx: ExtensionContext): void {
  clearTimer();
  if (!isRtkEnabledInPrefs()) {
    // Ensure any previously set status is cleared (e.g. preference was toggled off)
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  updateStatus(ctx);
  if (!ctx.hasUI) return;
  refreshTimer = setInterval(() => {
    updateStatus(ctx);
  }, REFRESH_INTERVAL_MS);
}

export function stopRtkStatusUpdates(ctx?: ExtensionContext): void {
  clearTimer();
  ctx?.ui.setStatus(STATUS_KEY, undefined);
}
