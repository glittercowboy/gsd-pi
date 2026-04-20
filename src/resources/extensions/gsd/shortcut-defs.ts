// Canonical GSD shortcut definitions used by registration, help text, and overlays.

import { formatShortcut } from "./files.js";

export type GSDShortcutId = "dashboard" | "notifications" | "parallel";

type GSDShortcutDef = {
  key: "g" | "n" | "p";
  action: string;
  command: string;
  /** Whether the Ctrl+Shift fallback is registered (false when it conflicts with an app keybinding). */
  hasFallback: boolean;
};

export const GSD_SHORTCUTS: Record<GSDShortcutId, GSDShortcutDef> = {
  dashboard: {
    key: "g",
    action: "Open GSD dashboard",
    command: "/gsd status",
    hasFallback: true,
  },
  notifications: {
    key: "n",
    action: "Open notification history",
    command: "/gsd notifications",
    hasFallback: true,
  },
  parallel: {
    key: "p",
    action: "Open parallel worker monitor",
    command: "/gsd parallel watch",
    hasFallback: false, // Ctrl+Shift+P conflicts with cycleModelBackward
  },
};

function combo(prefix: "Ctrl+Alt+" | "Ctrl+Shift+", key: string): string {
  return `${prefix}${key.toUpperCase()}`;
}

export function primaryShortcutCombo(id: GSDShortcutId): string {
  return combo("Ctrl+Alt+", GSD_SHORTCUTS[id].key);
}

export function fallbackShortcutCombo(id: GSDShortcutId): string {
  return combo("Ctrl+Shift+", GSD_SHORTCUTS[id].key);
}

export function shortcutPair(id: GSDShortcutId, formatter: (combo: string) => string = (combo) => combo): string {
  const primary = formatter(primaryShortcutCombo(id));
  if (!GSD_SHORTCUTS[id].hasFallback) return primary;
  return `${primary} / ${formatter(fallbackShortcutCombo(id))}`;
}

export function formattedShortcutPair(id: GSDShortcutId): string {
  return shortcutPair(id, formatShortcut);
}
