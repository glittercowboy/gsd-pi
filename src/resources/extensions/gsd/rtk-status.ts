import type { ExtensionContext } from "@gsd/pi-coding-agent";
import {
  ensureRtkSessionBaseline,
  formatRtkSavingsLabel,
  getRtkSessionSavings,
} from "../shared/rtk-session-stats.js";

const STATUS_KEY = "gsd-rtk";
const REFRESH_INTERVAL_MS = 30_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function clearTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const basePath = ctx.cwd;
  const sessionId = ctx.sessionManager.getSessionId();
  ensureRtkSessionBaseline(basePath, sessionId);
  const savings = getRtkSessionSavings(basePath, sessionId);
  ctx.ui.setStatus(STATUS_KEY, formatRtkSavingsLabel(savings) ?? undefined);
}

export function startRtkStatusUpdates(ctx: ExtensionContext): void {
  clearTimer();
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
