import { truncateToWidth } from "@gsd/pi-tui";
import { theme } from "../../../theme.js";

// ── Tree connector characters ────────────────────────────────────────
export const TREE_BRANCH = "\u251C\u2500 "; // "├─ "
export const TREE_LAST = "\u2514\u2500 "; // "└─ "
export const TREE_PIPE = "\u2502  "; // "│  "
export const TREE_SPACE = "   "; // 3 spaces

/**
 * Build a tree prefix string from ancestor-continuation flags and branch position.
 *
 * Each ancestor level contributes either a pipe ("│  ") or blank spacing ("   ")
 * depending on whether that ancestor has more siblings after it. The final segment
 * is the branch connector: "├─ " (more siblings) or "└─ " (last sibling).
 *
 * Used by session-selector for its simpler flat tree display.
 * tree-selector uses its own gutter-based char-by-char builder for richer rendering.
 */
export function buildTreePrefix(ancestorContinues: boolean[], isLast: boolean, depth: number): string {
	if (depth === 0) return "";
	const parts = ancestorContinues.map((continues) => (continues ? TREE_PIPE : TREE_SPACE));
	const branch = isLast ? TREE_LAST : TREE_BRANCH;
	return parts.join("") + branch;
}

// ── Scroll window ────────────────────────────────────────────────────

export interface ScrollWindow {
	/** First visible index (inclusive) */
	startIndex: number;
	/** Last visible index (exclusive) */
	endIndex: number;
}

/**
 * Compute a centered scroll window around `selectedIndex` within a list of `totalItems`.
 *
 * The window tries to center the selected item. When near the beginning or end of the
 * list the window clamps so it doesn't exceed bounds.
 */
export function computeScrollWindow(selectedIndex: number, totalItems: number, maxVisible: number): ScrollWindow {
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), totalItems - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, totalItems);
	return { startIndex, endIndex };
}

// ── Cursor & selection helpers ───────────────────────────────────────

/**
 * Return the cursor indicator for a list row.
 *
 * Selected:   "› " (accent-colored)
 * Unselected: "  " (two spaces, matching width)
 */
export function renderCursor(isSelected: boolean): string {
	return isSelected ? theme.fg("accent", "\u203A ") : "  ";
}

/**
 * Apply selected-row background highlight and truncate to `width`.
 */
export function applyRowHighlight(line: string, isSelected: boolean, width: number): string {
	const truncated = truncateToWidth(line, width);
	return isSelected ? theme.bg("selectedBg", truncated) : truncated;
}

// ── Scroll position indicator ────────────────────────────────────────

/**
 * Render a muted "(current/total)" position indicator, optionally with a suffix label.
 */
export function renderScrollPosition(
	selectedIndex: number,
	totalItems: number,
	width: number,
	suffixLabel?: string,
): string {
	const suffix = suffixLabel ?? "";
	return truncateToWidth(theme.fg("muted", `  (${selectedIndex + 1}/${totalItems})${suffix}`), width);
}
