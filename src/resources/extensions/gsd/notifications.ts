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
 * macOS: terminal-notifier / osascript (toast + sound), Linux: notify-send (toast),
 * Windows: PowerShell toast or sound depending on notifications.kind preference.
 *
 * notifications.kind controls delivery mode:
 *   - "toast" (default): shows a desktop notification with sound.
 *   - "sound": plays a system sound only — faster, no visual notification.
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
    const notifKind = loaded?.notifications?.kind ?? "toast";
    const command = buildDesktopNotificationCommand(process.platform, title, message, level, notifKind);
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
  notifKind: "sound" | "toast" = "toast",
): NotificationCommand | null {
  const normalizedTitle = normalizeNotificationText(title);
  const normalizedMessage = normalizeNotificationText(message);

  if (platform === "darwin") {
    if (notifKind === "sound") {
      return buildMacOSSoundCommand(level);
    }
    // "toast" — terminal-notifier or osascript (both include sound)
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
    if (notifKind === "sound") {
      return buildLinuxSoundCommand(level);
    }
    // "toast" — notify-send
    const urgency = level === "error" ? "critical" : level === "warning" ? "normal" : "low";
    return { file: "notify-send", args: ["-u", urgency, normalizedTitle, normalizedMessage] };
  }

  if (platform === "win32") {
    if (notifKind === "sound") {
      return buildWindowsSoundCommand(level);
    }
    // "toast" — WinRT toast with PowerShell's AUMID for reliable delivery
    return buildWindowsToastCommand(normalizedTitle, normalizedMessage);
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

// ─── Platform-specific sound-only commands ─────────────────────────────────

const MACOS_SOUND_MAP: Record<NotifyLevel, string> = {
  error: "/System/Library/Sounds/Basso.aiff",
  warning: "/System/Library/Sounds/Sosumi.aiff",
  info: "/System/Library/Sounds/Glass.aiff",
  success: "/System/Library/Sounds/Hero.aiff",
};

function buildMacOSSoundCommand(level: NotifyLevel): NotificationCommand {
  const soundFile = MACOS_SOUND_MAP[level] || MACOS_SOUND_MAP.info;
  const afplay = findExecutable("afplay");
  if (afplay) {
    return { file: afplay, args: [soundFile] };
  }
  // Fallback: osascript with sound only (no display notification)
  const sound = level === "error" ? 'sound name "Basso"' : 'sound name "Glass"';
  return { file: "osascript", args: ["-e", `do shell script "afplay ${soundFile}"`] };
}

const LINUX_SOUND_MAP: Record<NotifyLevel, string> = {
  error: "/usr/share/sounds/freedesktop/stereo/dialog-error.oga",
  warning: "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
  info: "/usr/share/sounds/freedesktop/stereo/complete.oga",
  success: "/usr/share/sounds/freedesktop/stereo/complete.oga",
};

function buildLinuxSoundCommand(level: NotifyLevel): NotificationCommand {
  const soundFile = LINUX_SOUND_MAP[level] || LINUX_SOUND_MAP.info;
  // Try paplay (PulseAudio) first, then aplay (ALSA)
  const paplay = findExecutable("paplay");
  if (paplay) {
    return { file: paplay, args: [soundFile] };
  }
  const aplay = findExecutable("aplay");
  if (aplay) {
    return { file: aplay, args: ["-q", soundFile.replace(".oga", ".wav")] };
  }
  // Fallback: use notify-send with hint to play sound
  return { file: "notify-send", args: ["-u", "low", "GSD", ""] };
}

const WINDOWS_SOUND_MAP: Record<NotifyLevel, string> = {
  error: "Hand",
  warning: "Exclamation",
  info: "Asterisk",
  success: "Beep",
};

function buildWindowsSoundCommand(level: NotifyLevel): NotificationCommand {
  const soundName = WINDOWS_SOUND_MAP[level] || WINDOWS_SOUND_MAP.info;
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-Command", `[System.Media.SystemSounds]::${soundName}.Play()`],
  };
}

// ─── Windows toast ─────────────────────────────────────────────────────────

/** PowerShell's own AUMID — required for WinRT toast delivery on Windows. */
const POWERSHELL_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function buildWindowsToastCommand(title: string, message: string): NotificationCommand {
  const safeTitle = title.replace(/'/g, "''");
  const safeMessage = message.replace(/'/g, "''");
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null",
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeMessage}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')`,
    `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}')`,
    `$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
  ].join("; ");

  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-Command", script],
  };
}
