// GSD Extension — Notification Widget
// Always-on ambient widget rendered belowEditor showing unread count and
// the most recent notification message. Refreshes every 5 seconds.
// Widget key: "gsd-notifications", placement: "belowEditor"

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { getUnreadCount, readNotifications } from "./notification-store.js";
import { formatShortcut } from "./files.js";

// ─── Pure rendering ──���────────────────────────���─────────────────────────

export function buildNotificationWidgetLines(): string[] {
  const unread = getUnreadCount();
  if (unread === 0) return [];

  const entries = readNotifications();
  const latest = entries[0]; // newest-first
  if (!latest) return [];

  const icon = latest.severity === "error" ? "✗" : latest.severity === "warning" ? "⚠" : "●";
  const badge = `${unread} unread`;
  const msgMax = 80;
  const truncated = latest.message.length > msgMax
    ? latest.message.slice(0, msgMax - 1) + "…"
    : latest.message;

  return [`  ${icon} [${badge}]  ${truncated}  (${formatShortcut("Ctrl+Alt+N")} to view)`];
}

// ─── Widget init ────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 5_000;

/**
 * Initialize the always-on notification widget (belowEditor).
 * Call once from session_start after the notification store is initialized.
 */
export function initNotificationWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  // String-array fallback for RPC mode
  ctx.ui.setWidget("gsd-notifications", buildNotificationWidgetLines(), { placement: "belowEditor" });

  // Factory-based widget for TUI mode
  ctx.ui.setWidget("gsd-notifications", (_tui, _theme) => {
    let cachedLines: string[] | undefined;

    const refresh = () => {
      cachedLines = undefined;
      _tui.requestRender();
    };

    const refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

    return {
      render(_width: number): string[] {
        if (!cachedLines) cachedLines = buildNotificationWidgetLines();
        return cachedLines;
      },
      invalidate(): void {
        cachedLines = undefined;
      },
      dispose(): void {
        clearInterval(refreshTimer);
      },
    };
  }, { placement: "belowEditor" });
}
