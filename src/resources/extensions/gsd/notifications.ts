// GSD Extension — Desktop Notification Helper
// Cross-platform desktop notifications for auto-mode events.

import { execFileSync } from "node:child_process";
import type { NotificationPreferences } from "./types.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { CmuxClient, emitOsc777Notification, resolveCmuxConfig } from "../cmux/index.js";

export type NotifyLevel = "info" | "success" | "warning" | "error";
export type NotificationKind = "complete" | "error" | "budget" | "milestone" | "attention";

interface NotificationCommand {
  file: string;
  args: string[];
}

/**
 * Send a native desktop notification. Non-blocking, non-fatal.
 * macOS: osascript, Linux: notify-send, Windows: skipped.
 */
export function sendDesktopNotification(
  title: string,
  message: string,
  level: NotifyLevel = "info",
  kind: NotificationKind = "complete",
): void {
  const loaded = loadEffectiveGSDPreferences()?.preferences;
  if (!shouldSendDesktopNotification(kind, loaded?.notifications)) return;

  const cmux = resolveCmuxConfig(loaded);
  if (cmux.notifications) {
    const delivered = CmuxClient.fromPreferences(loaded).notify(title, message);
    if (delivered) return;
    emitOsc777Notification(title, message);
  }

  try {
    const command = buildDesktopNotificationCommand(process.platform, title, message, level);
    if (!command) return;
    execFileSync(command.file, command.args, { timeout: 3000, stdio: "ignore" });
  } catch {
    // Non-fatal — desktop notifications are best-effort
  }
}

export function shouldSendDesktopNotification(
  kind: NotificationKind,
  preferences: NotificationPreferences | undefined = loadEffectiveGSDPreferences()?.preferences.notifications,
): boolean {
  if (preferences?.enabled === false) return false;

  switch (kind) {
    case "error":
      return preferences?.on_error ?? true;
    case "budget":
      return preferences?.on_budget ?? true;
    case "milestone":
      return preferences?.on_milestone ?? true;
    case "attention":
      return preferences?.on_attention ?? true;
    case "complete":
    default:
      return preferences?.on_complete ?? true;
  }
}

export function buildDesktopNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
  level: NotifyLevel = "info",
): NotificationCommand | null {
  const normalizedTitle = normalizeNotificationText(title);
  const normalizedMessage = normalizeNotificationText(message);

  if (platform === "darwin") {
    // Prefer terminal-notifier: registers as its own Notification Center app,
    // so it gets a proper permission entry in System Settings → Notifications.
    // osascript notifications are silently swallowed when the calling terminal
    // (Ghostty, iTerm2, etc.) lacks notification permissions — exits 0, no error.
    // See: https://github.com/gsd-build/gsd-2/issues/2632
    const tnPath = findExecutable("terminal-notifier");
    if (tnPath) {
      const sound = level === "error" ? "Basso" : "Glass";
      return { file: tnPath, args: ["-title", normalizedTitle, "-message", normalizedMessage, "-sound", sound] };
    }
    // Fallback: osascript (works if terminal app has notification permissions)
    const sound = level === "error" ? 'sound name "Basso"' : 'sound name "Glass"';
    const script = `display notification "${escapeAppleScript(normalizedMessage)}" with title "${escapeAppleScript(normalizedTitle)}" ${sound}`;
    return { file: "osascript", args: ["-e", script] };
  }

  if (platform === "linux") {
    const urgency = level === "error" ? "critical" : level === "warning" ? "normal" : "low";
    return { file: "notify-send", args: ["-u", urgency, normalizedTitle, normalizedMessage] };
  }

  return null;
}

function normalizeNotificationText(s: string): string {
  return s.replace(/\r?\n/g, " ").trim();
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Locate an executable on PATH. Returns absolute path or null.
 * Non-fatal — returns null on any error.
 */
function findExecutable(name: string): string | null {
  try {
    return execFileSync("which", [name], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}
