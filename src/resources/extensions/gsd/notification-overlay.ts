// GSD Extension — Notification History Overlay
// Scrollable panel showing all persisted notifications with severity filtering.
// Toggled with Ctrl+Alt+N (⌃⌥N on macOS) or opened from /gsd notifications.

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";

import {
  readNotifications,
  markAllRead,
  clearNotifications,
  getUnreadCount,
  type NotificationEntry,
  type NotifySeverity,
} from "./notification-store.js";
import { padRight, centerLine, joinColumns, formatDuration } from "../shared/mod.js";

type FilterMode = "all" | "error" | "warning" | "info";
const FILTER_CYCLE: FilterMode[] = ["all", "error", "warning", "info"];

function severityIcon(severity: NotifySeverity): string {
  switch (severity) {
    case "error": return "✗";
    case "warning": return "⚠";
    case "success": return "✓";
    case "info":
    default: return "●";
  }
}

/** Word-wrap plain text to fit within maxWidth columns. */
function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  // If a single word exceeds maxWidth, truncate it
  return lines.map((l) => l.length > maxWidth ? l.slice(0, maxWidth - 1) + "…" : l);
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
    return `${Math.floor(diffMs / 86400_000)}d ago`;
  } catch {
    return ts.slice(11, 19); // fallback: HH:MM:SS
  }
}

export class GSDNotificationOverlay {
  private tui: { requestRender: () => void };
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private scrollOffset = 0;
  private filterIndex = 0;
  private entries: NotificationEntry[] = [];
  private refreshTimer: ReturnType<typeof setInterval>;
  private disposed = false;
  private resizeHandler: (() => void) | null = null;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;

    // Mark all as read on open
    markAllRead();
    this.entries = readNotifications();

    // Resize handler
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);

    // Refresh every 3s for new notifications
    this.refreshTimer = setInterval(() => {
      if (this.disposed) return;
      const fresh = readNotifications();
      if (fresh.length !== this.entries.length) {
        this.entries = fresh;
        markAllRead();
        this.invalidate();
        this.tui.requestRender();
      }
    }, 3000);
  }

  private get filter(): FilterMode {
    return FILTER_CYCLE[this.filterIndex]!;
  }

  private get filteredEntries(): NotificationEntry[] {
    if (this.filter === "all") return this.entries;
    return this.entries.filter((e) => e.severity === this.filter);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("n"))) {
      this.dispose();
      this.onClose();
      return;
    }

    // Scroll
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scrollOffset++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = 999;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Filter cycle
    if (data === "f") {
      this.filterIndex = (this.filterIndex + 1) % FILTER_CYCLE.length;
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Clear all
    if (data === "c") {
      clearNotifications();
      this.entries = [];
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const content = this.buildContentLines(width);
    const maxVisibleRows = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24) - 2;
    const visibleContentRows = Math.min(content.length, maxVisibleRows);
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visibleContent = content.slice(this.scrollOffset, this.scrollOffset + visibleContentRows);

    const lines = this.wrapInBox(visibleContent, width);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  private wrapInBox(inner: string[], width: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines: string[] = [];

    lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
    for (const line of inner) {
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      lines.push(border("│") + " " + truncated + " ".repeat(padWidth) + " " + border("│"));
    }
    lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
    return lines;
  }

  private buildContentLines(width: number): string[] {
    const th = this.theme;
    const shellWidth = width - 4;
    const contentWidth = Math.min(shellWidth, 128);
    const sidePad = Math.max(0, Math.floor((shellWidth - contentWidth) / 2));
    const leftMargin = " ".repeat(sidePad);
    const lines: string[] = [];

    const row = (content = ""): string => {
      const truncated = truncateToWidth(content, contentWidth);
      return leftMargin + padRight(truncated, contentWidth);
    };
    const blank = () => row("");
    const hr = () => row(th.fg("dim", "─".repeat(contentWidth)));

    // Header
    const title = th.fg("accent", th.bold("Notifications"));
    const filterLabel = this.filter === "all"
      ? th.fg("dim", "all")
      : th.fg(this.filter === "error" ? "error" : this.filter === "warning" ? "warning" : "dim", this.filter);
    const count = `${this.filteredEntries.length} entries`;
    lines.push(row(joinColumns(
      `${title}  ${th.fg("dim", "filter:")} ${filterLabel}`,
      th.fg("dim", count),
      contentWidth,
    )));
    lines.push(hr());

    // Controls
    lines.push(row(th.fg("dim", "↑/↓ scroll  f filter  c clear  Esc close")));
    lines.push(blank());

    // Entries
    const filtered = this.filteredEntries;
    if (filtered.length === 0) {
      lines.push(blank());
      lines.push(row(th.fg("dim", this.entries.length === 0
        ? "No notifications yet."
        : `No ${this.filter} notifications.`)));
      lines.push(blank());
      return lines;
    }

    for (const entry of filtered) {
      const icon = severityIcon(entry.severity);
      const coloredIcon = entry.severity === "error" ? th.fg("error", icon)
        : entry.severity === "warning" ? th.fg("warning", icon)
          : entry.severity === "success" ? th.fg("success", icon)
            : th.fg("dim", icon);
      const time = th.fg("dim", formatTimestamp(entry.ts));
      const source = entry.source === "workflow-logger" ? th.fg("dim", " [engine]") : "";

      // Measure actual prefix width for wrapping
      const prefix = `${coloredIcon} ${time}${source}  `;
      const prefixWidth = visibleWidth(prefix);
      const msgMaxWidth = Math.max(10, contentWidth - prefixWidth);

      // Wrap long messages onto continuation lines indented to align with message start
      const msgLines = wrapText(entry.message, msgMaxWidth);
      const indent = " ".repeat(prefixWidth);
      for (let i = 0; i < msgLines.length; i++) {
        if (i === 0) {
          lines.push(row(`${prefix}${msgLines[i]}`));
        } else {
          lines.push(row(`${indent}${msgLines[i]}`));
        }
      }
    }

    return lines;
  }
}
