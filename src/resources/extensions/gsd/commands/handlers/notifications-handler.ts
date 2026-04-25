// GSD Extension — /gsd notifications Command Handler
// View, filter, and clear the persistent notification history.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  readNotifications,
  clearNotifications,
  getUnreadCount,
  suppressPersistence,
  unsuppressPersistence,
  type NotifySeverity,
} from "../../notification-store.js";
import { GSDNotificationOverlay } from "../../notification-overlay.js";

const MAX_INLINE_ENTRIES = 40;

function severityIcon(severity: NotifySeverity): string {
  switch (severity) {
    case "error": return "✗";
    case "warning": return "⚠";
    case "success": return "✓";
    case "info":
    default: return "●";
  }
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString("en-US", { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return ts.slice(0, 19);
  }
}

export async function handleNotificationsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<boolean> {
  // /gsd notifications clear
  if (args === "clear") {
    clearNotifications();
    // Suppress persistence so the confirmation toast doesn't re-populate the store
    suppressPersistence();
    try {
      ctx.ui.notify("All notifications cleared.", "success");
    } finally {
      unsuppressPersistence();
    }
    return true;
  }

  // /gsd notifications tail [N]
  if (args === "tail" || args.startsWith("tail ")) {
    const countStr = args.replace(/^tail\s*/, "").trim();
    const count = countStr ? parseInt(countStr, 10) : 20;
    const all = readNotifications();
    const n = isNaN(count) || count < 1 ? 20 : Math.min(count, MAX_INLINE_ENTRIES);
    const entries = all.slice(0, n);

    if (entries.length === 0) {
      ctx.ui.notify("No notifications.", "info");
      return true;
    }

    const lines = entries.map((e) =>
      `${severityIcon(e.severity)} [${formatTimestamp(e.ts)}] ${e.message}`,
    );
    const suffix = all.length > entries.length
      ? `\n... and ${all.length - entries.length} more (open /gsd notifications to browse all)`
      : "";
    ctx.ui.notify(`Last ${entries.length} notification(s):\n${lines.join("\n")}${suffix}`, "info");
    return true;
  }

  // /gsd notifications filter <severity>
  if (args.startsWith("filter ")) {
    const severity = args.replace(/^filter\s+/, "").trim().toLowerCase();
    if (!["error", "warning", "info", "success"].includes(severity)) {
      ctx.ui.notify("Usage: /gsd notifications filter <error|warning|info|success>", "warning");
      return true;
    }
    const entries = readNotifications().filter((e) => e.severity === severity);

    if (entries.length === 0) {
      ctx.ui.notify(`No ${severity} notifications.`, "info");
      return true;
    }

    const lines = entries.slice(0, 20).map((e) =>
      `${severityIcon(e.severity)} [${formatTimestamp(e.ts)}] ${e.message}`,
    );
    const suffix = entries.length > 20
      ? `\n... and ${entries.length - 20} more (open /gsd notifications to browse all)`
      : "";
    ctx.ui.notify(`${severity} notifications (${entries.length}):\n${lines.join("\n")}${suffix}`, "info");
    return true;
  }

  // /gsd notifications (no args) — open overlay in TUI, or print summary
  if (args === "" || args === "status") {
    // Try overlay first (TUI mode)
    if (ctx.hasUI) {
      try {
        const result = await ctx.ui.custom<boolean>(
          (tui, theme, _kb, done) => new GSDNotificationOverlay(tui, theme, () => done(true)),
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 60,
              maxHeight: "88%",
              anchor: "center",
              backdrop: true,
            },
          },
        );
        if (result !== undefined) {
          return true;
        }
      } catch {
        // Fall through to text output if overlay fails
      }
    }

    // Text fallback (RPC/headless mode)
    const unread = getUnreadCount();
    const entries = readNotifications().slice(0, 10);
    if (entries.length === 0) {
      ctx.ui.notify("No notifications.", "info");
      return true;
    }

    const lines = entries.map((e) =>
      `${severityIcon(e.severity)} [${formatTimestamp(e.ts)}] ${e.message}`,
    );
    const header = unread > 0 ? `${unread} unread — ` : "";
    ctx.ui.notify(`${header}Recent notifications:\n${lines.join("\n")}`, "info");
    return true;
  }

  // Unknown subcommand
  ctx.ui.notify(
    "Usage: /gsd notifications [clear|tail [N]|filter <severity>]",
    "warning",
  );
  return true;
}
