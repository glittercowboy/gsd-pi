/**
 * Shared pure formatting utilities — no @gsd/pi-tui dependency.
 *
 * ANSI-aware layout helpers (padRight, joinColumns, centerLine, fitColumns)
 * live in layout-utils.ts to avoid pulling @gsd/pi-tui into modules that
 * run outside jiti's alias resolution (e.g. HTML report generation via
 * dynamic import in auto-loop).
 */

// ─── Duration Formatting ──────────────────────────────────────────────────────

/** Format a millisecond duration as a compact human-readable string. */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 1000) return `${ms}ms`;
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

// ─── Hyperlinks ──────────────────────────────────────────────────────────────

/** Wrap text in an OSC 8 hyperlink for terminals that support clickable links. */
export function fileLink(filePath: string, displayText?: string): string {
  const uri = `file://${filePath}`;
  const label = displayText ?? filePath;
  return `\x1b]8;;${uri}\x07${label}\x1b]8;;\x07`;
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
