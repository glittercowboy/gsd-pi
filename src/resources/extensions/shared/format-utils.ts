/**
 * Shared formatting and layout utilities for TUI dashboard components.
 *
 * Consolidates helpers that were previously duplicated across
 * auto-dashboard.ts, dashboard-overlay.ts, and visualizer-views.ts.
 */

import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";

// ─── Duration Formatting ──────────────────────────────────────────────────────

/** Format a millisecond duration as a compact human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// ─── Token Count Formatting ──────────────────────────────────────────────────

/** Format a token count as a compact human-readable string (e.g. 1.5k, 1.50M). */
export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

// ─── Layout Helpers ───────────────────────────────────────────────────────────

/** Pad a string with trailing spaces to fill `width` (ANSI-aware). */
export function padRight(content: string, width: number): string {
  const vis = visibleWidth(content);
  return content + " ".repeat(Math.max(0, width - vis));
}

/** Build a line with left-aligned and right-aligned content. */
export function joinColumns(left: string, right: string, width: number): string {
  const leftW = visibleWidth(left);
  const rightW = visibleWidth(right);
  if (leftW + rightW + 2 > width) {
    return truncateToWidth(`${left}  ${right}`, width);
  }
  return left + " ".repeat(width - leftW - rightW) + right;
}

/** Center content within `width` (ANSI-aware). */
export function centerLine(content: string, width: number): string {
  const vis = visibleWidth(content);
  if (vis >= width) return truncateToWidth(content, width);
  const leftPad = Math.floor((width - vis) / 2);
  return " ".repeat(leftPad) + content;
}

/** Join as many parts as fit within `width`, separated by `separator`. */
export function fitColumns(parts: string[], width: number, separator = "  "): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return "";
  let result = filtered[0];
  for (let i = 1; i < filtered.length; i++) {
    const candidate = `${result}${separator}${filtered[i]}`;
    if (visibleWidth(candidate) > width) break;
    result = candidate;
  }
  return truncateToWidth(result, width);
}

// ─── Text Truncation ─────────────────────────────────────────────────────────

/** Truncate a string to `maxLength` characters, replacing the last character with an ellipsis if needed. */
export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 1) + "…"
}

// ─── Data Visualization ───────────────────────────────────────────────────────

/**
 * Render a sparkline from numeric values using Unicode block characters.
 * Uses loop-based max to avoid stack overflow on large arrays.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  let max = 0;
  for (const v of values) {
    if (v > max) max = v;
  }
  if (max === 0) return chars[0].repeat(values.length);
  return values.map(v => chars[Math.min(7, Math.floor((v / max) * 7))]).join("");
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

/** Format an ISO date string as a compact locale string (e.g. "Mar 17, 2025, 02:30 PM"). */
export function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ─── ANSI Stripping ───────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── String Array Normalization ─────────────────────────────────────────────

/**
 * Normalize an unknown value to a string array.
 * Filters to string items, trims whitespace, removes empty strings.
 * Optionally deduplicates.
 */
export function normalizeStringArray(value: unknown, options?: { dedupe?: boolean }): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean);
  return options?.dedupe ? [...new Set(items)] : items;
}
