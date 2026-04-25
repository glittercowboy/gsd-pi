/**
 * Overlay layout resolution, compositing, and rendering utilities.
 *
 * Extracted from tui.ts — these are pure functions that compute overlay
 * positions and composite overlay content onto base terminal lines.
 */

import type { OverlayAnchor, OverlayOptions, SizeValue } from "./tui.js";
import { applyBackgroundToLine, extractSegments, sliceByColumn, sliceWithWidth, truncateToWidth, visibleWidth } from "./utils.js";
import { isImageLine } from "./terminal-image.js";
import { CURSOR_MARKER } from "./tui.js";

// ─── Size parsing ───────────────────────────────────────────────────────────

/** Parse a SizeValue into absolute value given a reference size */
export function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

// ─── Anchor resolution ──────────────────────────────────────────────────────

export function resolveAnchorRow(
	anchor: OverlayAnchor,
	height: number,
	availHeight: number,
	marginTop: number,
): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

export function resolveAnchorCol(
	anchor: OverlayAnchor,
	width: number,
	availWidth: number,
	marginLeft: number,
): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

// ─── Overlay layout resolution ──────────────────────────────────────────────

export interface OverlayLayout {
	width: number;
	row: number;
	col: number;
	maxHeight: number | undefined;
}

/**
 * Resolve overlay layout from options.
 * Returns { width, row, col, maxHeight } for rendering.
 */
export function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): OverlayLayout {
	const opt = options ?? {};

	// Parse margin (clamp to non-negative)
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	// Available space after margins
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	// === Resolve width ===
	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	// Apply minWidth
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	// Clamp to available space
	width = Math.max(1, Math.min(width, availWidth));

	// === Resolve maxHeight ===
	let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
	// Clamp to available space
	if (maxHeight !== undefined) {
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	}

	// Effective overlay height (may be clamped by maxHeight)
	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

	// === Resolve position ===
	let row: number;
	let col: number;

	if (opt.row !== undefined) {
		if (typeof opt.row === "string") {
			// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
			const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxRow = Math.max(0, availHeight - effectiveHeight);
				const percent = parseFloat(match[1]) / 100;
				row = marginTop + Math.floor(maxRow * percent);
			} else {
				// Invalid format, fall back to center
				row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
			}
		} else {
			// Absolute row position
			row = opt.row;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
	}

	if (opt.col !== undefined) {
		if (typeof opt.col === "string") {
			// Percentage: 0% = left, 100% = right (overlay stays within bounds)
			const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxCol = Math.max(0, availWidth - width);
				const percent = parseFloat(match[1]) / 100;
				col = marginLeft + Math.floor(maxCol * percent);
			} else {
				// Invalid format, fall back to center
				col = resolveAnchorCol("center", width, availWidth, marginLeft);
			}
		} else {
			// Absolute column position
			col = opt.col;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}

	// Apply offsets
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	// Clamp to terminal bounds (respecting margins)
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

// ─── Line compositing ───────────────────────────────────────────────────────

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Append reset sequences to each non-image line. */
export function applyLineResets(lines: string[]): string[] {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!isImageLine(line)) {
			lines[i] = line + SEGMENT_RESET;
		}
	}
	return lines;
}

/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
export function compositeLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	// Single pass through baseLine extracts both before and after segments
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

	// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

	// Pad segments to target widths
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);

	// Compose result
	const r = SEGMENT_RESET;
	const result =
		base.before +
		" ".repeat(beforePad) +
		r +
		overlay.text +
		" ".repeat(overlayPad) +
		r +
		base.after +
		" ".repeat(afterPad);

	// CRITICAL: Always verify and truncate to terminal width.
	// This is the final safeguard against width overflow which would crash the TUI.
	// Width tracking can drift from actual visible width due to:
	// - Complex ANSI/OSC sequences (hyperlinks, colors)
	// - Wide characters at segment boundaries
	// - Edge cases in segment extraction
	const resultWidth = visibleWidth(result);
	if (resultWidth <= totalWidth) {
		return result;
	}
	// Truncate with strict=true to ensure we don't exceed totalWidth
	return sliceByColumn(result, 0, totalWidth, true);
}

// ─── Overlay compositing ────────────────────────────────────────────────────

export interface OverlayEntry {
	component: { render(width: number): string[]; invalidate?(): void };
	options?: OverlayOptions;
	hidden: boolean;
	focusOrder: number;
}

/** Check if an overlay entry is currently visible */
export function isOverlayVisible(
	entry: OverlayEntry,
	termWidth: number,
	termHeight: number,
): boolean {
	if (entry.hidden) return false;
	if (entry.options?.visible) {
		return entry.options.visible(termWidth, termHeight);
	}
	return true;
}

/**
 * Composite all visible overlays into content lines.
 * Sorted by focusOrder (higher = on top).
 */
export function compositeOverlays(
	lines: string[],
	overlayStack: OverlayEntry[],
	termWidth: number,
	termHeight: number,
	maxLinesRendered: number,
): string[] {
	if (overlayStack.length === 0) return lines;
	const result = [...lines];

	// Pre-render all visible overlays and calculate positions
	const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
	let minLinesNeeded = result.length;

	const visibleEntries = overlayStack.filter((e) => isOverlayVisible(e, termWidth, termHeight));
	visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
	for (const entry of visibleEntries) {
		const { component, options } = entry;

		// Get layout with height=0 first to determine width and maxHeight
		// (width and maxHeight don't depend on overlay height)
		const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);

		// Render component at calculated width
		let overlayLines = component.render(width);

		// Apply maxHeight if specified
		if (maxHeight !== undefined && overlayLines.length > maxHeight) {
			overlayLines = overlayLines.slice(0, maxHeight);
		}

		// Get final row/col with actual overlay height
		const { row, col } = resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

		rendered.push({ overlayLines, row, col, w: width });
		minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
	}

	// Ensure result covers the terminal working area to keep overlay positioning stable across resizes.
	// maxLinesRendered can exceed current content length after a shrink; pad to keep viewportStart consistent.
	const workingHeight = Math.max(maxLinesRendered, minLinesNeeded);

	// Extend result with empty lines if content is too short for overlay placement or working area
	while (result.length < workingHeight) {
		result.push("");
	}

	const viewportStart = Math.max(0, workingHeight - termHeight);

	// Apply backdrop dimming if any visible overlay requests it.
	// Uses dim + gray foreground so text fades without painting empty lines.
	const hasBackdrop = visibleEntries.some((e) => e.options?.backdrop);
	if (hasBackdrop) {
		const dimFn = (text: string) => `\x1b[2m\x1b[38;5;240m${text}\x1b[39m\x1b[22m`;
		for (let i = viewportStart; i < result.length; i++) {
			if (!isImageLine(result[i]) && result[i].length > 0) {
				result[i] = applyBackgroundToLine(result[i], termWidth, dimFn);
			}
		}
	}

	// Composite each overlay
	for (const { overlayLines, row, col, w } of rendered) {
		for (let i = 0; i < overlayLines.length; i++) {
			const idx = viewportStart + row + i;
			if (idx >= 0 && idx < result.length) {
				// Defensive: truncate overlay line to declared width before compositing
				// (components should already respect width, but this ensures it)
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
				result[idx] = compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
			}
		}
	}

	return result;
}

// ─── Cursor extraction ──────────────────────────────────────────────────────

/**
 * Find and extract cursor position from rendered lines.
 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
 * Only scans the bottom terminal height lines (visible viewport).
 * @param lines - Rendered lines to search (mutated to strip marker)
 * @param height - Terminal height (visible viewport size)
 * @returns Cursor position { row, col } or null if no marker found
 */
export function extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
	// Only scan the bottom `height` lines (visible viewport)
	const viewportTop = Math.max(0, lines.length - height);
	for (let row = lines.length - 1; row >= viewportTop; row--) {
		const line = lines[row];
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex !== -1) {
			// Calculate visual column (width of text before marker)
			const beforeMarker = line.slice(0, markerIndex);
			const col = visibleWidth(beforeMarker);

			// Strip marker from the line
			lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

			return { row, col };
		}
	}
	return null;
}
