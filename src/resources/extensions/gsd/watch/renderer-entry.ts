// GSD Watch — Renderer subprocess entry point: viewport scrolling, signal wiring, quit key detection, tree rendering
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startPlanningWatcher } from "./watcher.js";
import { clearWatchLock } from "./orchestrator.js";
import { gsdRoot } from "../paths.js";
import { buildMilestoneTree } from "./tree-model.js";
import { renderTreeLines } from "./tree-renderer.js";
import type { VisibleNode } from "./tree-renderer.js";
import { visibleWidth, truncateToWidth } from "@gsd/pi-tui";
import type { FSWatcher } from "chokidar";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Signals that should trigger cleanup and graceful exit. */
export const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];

/** Minimum PTY width to guard against zero-width pane at startup (Pitfall 2). */
const MIN_WIDTH = 40;

/** Minimum PTY height to guard against zero-height pane and non-TTY contexts. */
const MIN_HEIGHT = 3;

/** Time window (ms) within which a repeated key press counts as a quit sequence. */
const QUIT_TIMEOUT_MS = 500;

// ─── PTY Width Guard ──────────────────────────────────────────────────────────

/**
 * Returns the effective terminal width, enforcing a minimum of MIN_WIDTH (40)
 * to guard against PTY width=0 at pane creation time.
 */
export function getEffectiveWidth(): number {
  return Math.max(process.stdout.columns || 0, MIN_WIDTH);
}

// ─── Quit Key State Machine ───────────────────────────────────────────────────

let lastKey = "";
let lastKeyTime = 0;

/**
 * Reset the quit-sequence state machine.
 * Exported for test isolation (call in beforeEach).
 */
export function resetQuitState(): void {
  lastKey = "";
  lastKeyTime = 0;
}

/**
 * Parse a raw keypress chunk from stdin and detect quit sequences:
 *   - `qq` (two q presses within QUIT_TIMEOUT_MS)
 *   - `\x1b\x1b` (two Esc presses within QUIT_TIMEOUT_MS)
 *   - `\x03` (Ctrl+C raw byte in raw mode)
 *
 * Returns true if the current keypress completes a quit sequence.
 */
export function parseQuitSequence(chunk: string): boolean {
  // Ctrl+C raw byte in raw mode
  if (chunk === "\x03") {
    lastKey = "";
    lastKeyTime = 0;
    return true;
  }

  const now = Date.now();

  if (
    chunk === "q" &&
    lastKey === "q" &&
    now - lastKeyTime < QUIT_TIMEOUT_MS
  ) {
    lastKey = "";
    lastKeyTime = 0;
    return true;
  }

  if (
    chunk === "\x1b" &&
    lastKey === "\x1b" &&
    now - lastKeyTime < QUIT_TIMEOUT_MS
  ) {
    lastKey = "";
    lastKeyTime = 0;
    return true;
  }

  lastKey = chunk;
  lastKeyTime = now;
  return false;
}

// ─── PTY Height Guard ─────────────────────────────────────────────────────────

/**
 * Returns the effective terminal height, enforcing a minimum of MIN_HEIGHT (3)
 * to guard against PTY height=0 at pane creation and undefined in non-TTY contexts.
 */
export function getEffectiveHeight(): number {
  return Math.max(process.stdout.rows || 0, MIN_HEIGHT);
}

// ─── Viewport State ───────────────────────────────────────────────────────────

/** Current top-of-viewport line index. Module-level state, mirrors lastKey/lastKeyTime pattern. */
let viewportOffset = 0;

/**
 * Reset the viewport state.
 * Exported for test isolation (call in beforeEach).
 */
export function resetViewportState(): void {
  viewportOffset = 0;
}

/**
 * Returns the current viewport offset.
 * Exported for test assertions.
 */
export function getViewportOffset(): number {
  return viewportOffset;
}

// ─── Navigation State ────────────────────────────────────────────────────────

/** Current cursor position index into the lastRenderedNodes array. */
let cursorIndex = 0;

/** Set of phase dirName values that are collapsed (hiding child plans). */
let collapsedPhases: Set<string> = new Set();

/** Whether the help overlay is currently visible (replaces tree content). */
let helpOverlayVisible = false;

/** Parallel node metadata from the most recent renderTreeLines() call. */
let lastRenderedNodes: VisibleNode[] = [];

/**
 * Reset all navigation state.
 * Exported for test isolation (call in beforeEach).
 */
export function resetNavigationState(): void {
  cursorIndex = 0;
  collapsedPhases = new Set();
  helpOverlayVisible = false;
  lastRenderedNodes = [];
}

/** Returns the current cursor index. Exported for test assertions. */
export function getCursorIndex(): number { return cursorIndex; }

/** Returns a copy of the current collapsed phases set. Exported for test assertions. */
export function getCollapsedPhases(): Set<string> { return new Set(collapsedPhases); }

/** Returns whether the help overlay is currently visible. Exported for test assertions. */
export function isHelpOverlayVisible(): boolean { return helpOverlayVisible; }

// ─── Cursor Highlight ────────────────────────────────────────────────────────

/**
 * Wrap a rendered tree line in ANSI reverse video (D-01), padded to fill
 * the full terminal width so the highlight bar spans the entire row.
 */
export function applyCursorHighlight(line: string, width: number): string {
  const visLen = visibleWidth(line);
  const padded = line + " ".repeat(Math.max(0, width - visLen));
  return `\x1b[7m${padded}\x1b[0m`;
}

// ─── Cursor Viewport Sync ───────────────────────────────────────────────────

/**
 * Adjust viewportOffset so that the cursor is visible (D-04).
 * - If cursor is above viewport: scroll up to cursor.
 * - If cursor is below viewport: scroll down so cursor is at bottom of viewport.
 * - If cursor is within viewport: no change.
 */
export function ensureCursorInViewport(cursor: number, totalNodes: number, contentHeight: number): void {
  if (cursor < viewportOffset) {
    viewportOffset = cursor;
  } else if (cursor >= viewportOffset + contentHeight) {
    viewportOffset = cursor - contentHeight + 1;
  }
  // Clamp viewportOffset to valid range
  const maxOffset = Math.max(0, totalNodes - contentHeight);
  viewportOffset = Math.max(0, Math.min(viewportOffset, maxOffset));
}

// ─── Help Overlay ───────────────────────────────────────────────────────────

/**
 * Render the help overlay as an array of terminal-safe strings (D-12, D-13, D-14).
 * Contains two sections: KEYBINDINGS and BADGE LEGEND.
 */
export function renderHelpOverlayLines(width: number): string[] {
  const KEY_COL_WIDTH = 14;
  const KEYBINDINGS: [string, string][] = [
    ["j / k",        "Move cursor down / up"],
    ["h / l",        "Collapse / expand phase"],
    ["↑ / ↓",        "Scroll viewport"],
    ["g / G",        "Jump to top / bottom"],
    ["?",            "Toggle this help overlay"],
    ["qq / EscEsc",  "Quit"],
    ["Ctrl+C",       "Quit (force)"],
  ];
  const BADGE_LEGEND: [string, string][] = [
    ["Pos 1", "CONTEXT"],
    ["Pos 2", "RESEARCH"],
    ["Pos 3", "UI-SPEC"],
    ["Pos 4", "PLAN"],
    ["Pos 5", "SUMMARY"],
    ["Pos 6", "VERIFICATION"],
    ["Pos 7", "HUMAN-UAT"],
  ];

  const lines: string[] = [];
  lines.push("");
  lines.push("KEYBINDINGS");
  lines.push("");
  for (const [key, desc] of KEYBINDINGS) {
    const keyPadded = key + " ".repeat(Math.max(0, KEY_COL_WIDTH - visibleWidth(key)));
    const descTrunc = truncateToWidth(desc, Math.max(1, width - KEY_COL_WIDTH), "…");
    lines.push(keyPadded + descTrunc);
  }
  lines.push("");
  lines.push("BADGE LEGEND");
  lines.push("");
  for (const [pos, name] of BADGE_LEGEND) {
    const posPadded = pos + " ".repeat(Math.max(0, KEY_COL_WIDTH - visibleWidth(pos)));
    const nameTrunc = truncateToWidth(name, Math.max(1, width - KEY_COL_WIDTH), "…");
    lines.push(posPadded + nameTrunc);
  }

  return lines;
}

// ─── Arrow Key Parser ─────────────────────────────────────────────────────────

export type ArrowDirection = "up" | "down" | null;

/**
 * Parse a raw keypress chunk and detect ANSI arrow key sequences.
 * Returns "up", "down", or null for non-arrow input.
 *
 * Per Pattern 3: run BEFORE parseQuitSequence in the stdin data handler so that
 * the \x1b prefix of arrow sequences never reaches the quit state machine.
 */
export function parseArrowKey(chunk: string): ArrowDirection {
  if (chunk === "\x1b[A") return "up";
  if (chunk === "\x1b[B") return "down";
  return null;
}

// ─── Navigation Key Parser ──────────────────────────────────────────────────────

export type NavKey = "cursor-up" | "cursor-down" | "collapse" | "expand" |
                     "jump-top" | "jump-bottom" | "help" | null;

/**
 * Parse a raw keypress chunk and detect vim-style navigation keys.
 * Returns the NavKey action or null for non-navigation input.
 *
 * Must be called BEFORE parseArrowKey in the stdin data handler (D-15).
 */
export function parseNavKey(chunk: string): NavKey {
  if (chunk === "j") return "cursor-down";
  if (chunk === "k") return "cursor-up";
  if (chunk === "h") return "collapse";
  if (chunk === "l") return "expand";
  if (chunk === "g") return "jump-top";
  if (chunk === "G") return "jump-bottom";
  if (chunk === "?") return "help";
  return null;
}

// ─── Viewport Scroll ──────────────────────────────────────────────────────────

/**
 * Mutate viewportOffset by delta, clamped to [0, totalLines - contentHeight].
 */
export function scrollViewport(delta: number, totalLines: number, contentHeight: number): void {
  const maxOffset = Math.max(0, totalLines - contentHeight);
  viewportOffset = Math.max(0, Math.min(viewportOffset + delta, maxOffset));
}

// ─── Viewport Renderer ────────────────────────────────────────────────────────

/**
 * Build the centered status bar string.
 * Hides ▲ when at top (offset === 0), hides ▼ when at bottom.
 */
function buildStatusBar(
  offset: number,
  total: number,
  contentHeight: number,
  width: number
): string {
  const upArrow = offset > 0 ? "▲" : " ";
  const downArrow = offset + contentHeight < total ? "▼" : " ";
  const positionText = `${offset + 1}/${total}`;
  const rawBar = `${upArrow} ${positionText} ${downArrow}`;
  const barWidth = visibleWidth(rawBar);
  if (barWidth <= width) {
    const padding = Math.floor((width - barWidth) / 2);
    return " ".repeat(padding) + rawBar;
  }
  return truncateToWidth(rawBar, width, "");
}

/**
 * Slice the full line array into a viewport window and append a conditional status bar.
 *
 * Per Pitfall 2: status bar row only reserved when scrollable (total > height).
 * When tree fits, returns all lines joined — no height reduction, no status bar.
 */
export function renderViewport(
  lines: string[],
  offset: number,
  height: number,
  width: number
): string {
  const total = lines.length;
  const scrollable = total > height;

  if (!scrollable) {
    return lines.join("\n");
  }

  // Reserve 1 row for status bar when scrollable
  const contentHeight = height - 1;
  const clampedOffset = Math.max(0, Math.min(offset, Math.max(0, total - contentHeight)));
  const visible = lines.slice(clampedOffset, clampedOffset + contentHeight);
  const statusBar = buildStatusBar(clampedOffset, total, contentHeight, width);

  return visible.join("\n") + "\n" + statusBar;
}

// ─── Placeholder Renderer ─────────────────────────────────────────────────────

/**
 * Render a contextual placeholder message to stdout.
 *
 * Per D-09, D-10, D-11, D-12:
 *   - If PROJECT.md found: outputs "[ProjectName]\nLoading project..."
 *   - If .planning/ doesn't exist: outputs waiting/setup message
 *   - If .planning/ exists but empty/no phases: outputs "No phases found" message
 *   - Otherwise: outputs "Loading project..."
 */
export function renderPlaceholder(projectRoot: string): void {
  // Clear screen and move cursor to top-left
  process.stdout.write("\x1b[2J\x1b[H");

  const planningDir = join(projectRoot, ".planning");

  // .planning/ doesn't exist at all
  if (!existsSync(planningDir)) {
    process.stdout.write(
      "Waiting for project...\n(Run /gsd:new-project to get started)\n"
    );
    return;
  }

  // Try to read PROJECT.md and extract project name from first "# " heading
  const projectMdPath = join(planningDir, "PROJECT.md");
  if (existsSync(projectMdPath)) {
    try {
      const content = readFileSync(projectMdPath, "utf-8");
      const match = content.match(/^#\s+(.+)$/m);
      if (match && match[1]) {
        const projectName = match[1].trim();
        process.stdout.write(`${projectName}\nLoading project...\n`);
        return;
      }
    } catch {
      // Fall through to generic message
    }
  }

  // .planning/ exists but no PROJECT.md (or couldn't parse heading)
  process.stdout.write("Loading project...\n");
}

// ─── Tree Renderer ────────────────────────────────────────────────────────────

/** Cache of last rendered lines — used by arrow key handler and resize handler. */
let lastRenderedLines: string[] = [];

/**
 * Render the full project tree to stdout through the viewport.
 * Updates lastRenderedLines and lastRenderedNodes so navigation and resize handlers work.
 * Applies cursor highlight (reverse video) to the cursor row (D-01).
 * When help overlay is visible, renders overlay content instead of tree (D-12).
 * Uses single atomic write to prevent flicker (Pitfall 5 from research).
 */
export function renderTree(projectRoot: string): void {
  const width = getEffectiveWidth();
  const height = getEffectiveHeight();
  const milestone = buildMilestoneTree(projectRoot);

  // Prune stale collapse entries (D-11): remove any dirName that no longer exists
  const activeDirNames = new Set(milestone.phases.map(p => p.dirName));
  for (const d of collapsedPhases) {
    if (!activeDirNames.has(d)) collapsedPhases.delete(d);
  }

  const { lines, nodes } = renderTreeLines(milestone, width, collapsedPhases);

  // Clamp cursor to valid range after nodes may have changed
  cursorIndex = Math.max(0, Math.min(cursorIndex, nodes.length - 1));

  // Store for use by arrow key handler, resize handler, and cursor-sticky logic
  lastRenderedLines = lines;
  lastRenderedNodes = nodes;

  let outputLines: string[];

  if (helpOverlayVisible) {
    // Help overlay replaces tree content (D-12, D-15)
    outputLines = renderHelpOverlayLines(width);
  } else {
    // Apply cursor highlight (reverse video) to the cursor row (D-01)
    outputLines = lines.map((line, i) =>
      i === cursorIndex ? applyCursorHighlight(line, width) : line
    );
  }

  const output = renderViewport(outputLines, viewportOffset, height, width);
  // Atomic single write: clear screen + content in one call to prevent flicker
  process.stdout.write("\x1b[2J\x1b[H" + output + "\n");
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Perform a clean shutdown:
 *   1. Disable raw mode on stdin (if TTY)
 *   2. Close the file watcher
 *   3. Remove the watch lock file
 *   4. Exit with code 0
 */
async function shutdown(
  watcher: FSWatcher,
  gsdDir: string
): Promise<void> {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  await watcher.close();
  clearWatchLock(gsdDir);
  process.exit(0);
}

// ─── Main Execution Block ─────────────────────────────────────────────────────

// Only run when executed directly as a subprocess, not when imported for testing.
const isMainModule =
  process.argv[1]?.endsWith("renderer-entry.ts") ||
  process.argv[1]?.endsWith("renderer-entry.js");

if (isMainModule) {
  const projectRoot = process.argv[2];
  if (!projectRoot) {
    process.stderr.write(
      "renderer-entry: missing required argument: projectRoot\n"
    );
    process.exit(1);
  }

  const gsdDir = gsdRoot(projectRoot);
  const planningDir = join(projectRoot, ".planning");

  // Render initial tree
  renderTree(projectRoot);

  // Start file watcher — smart auto-follow on file changes (D-02)
  const watcher = startPlanningWatcher(planningDir, () => {
    // Smart auto-follow (D-02): only scroll to active phase if it was already visible
    const height = getEffectiveHeight();
    const oldLines = lastRenderedLines;
    const total = oldLines.length;
    const scrollable = total > height;
    const contentHeight = scrollable ? height - 1 : height;

    // Find active phase (◆) in current (pre-refresh) lines
    const activeIndex = oldLines.findIndex((line) => line.includes("◆"));
    const wasInView =
      activeIndex >= 0 &&
      activeIndex >= viewportOffset &&
      activeIndex < viewportOffset + contentHeight;

    // Cursor-sticky (D-05): record the logical node the cursor is on before re-render
    const prevNode = lastRenderedNodes[cursorIndex];

    // Re-render (this updates lastRenderedLines and lastRenderedNodes)
    renderTree(projectRoot);

    // Cursor-sticky (D-05): restore cursor to same logical node after re-render
    if (prevNode) {
      const newIdx = lastRenderedNodes.findIndex(n => {
        if (prevNode.kind === "phase" && n.kind === "phase") return n.dirName === prevNode.dirName;
        if (prevNode.kind === "plan" && n.kind === "plan") return n.planId === prevNode.planId;
        return n.kind === "milestone" && prevNode.kind === "milestone";
      });
      cursorIndex = newIdx >= 0 ? newIdx : Math.min(cursorIndex, Math.max(0, lastRenderedNodes.length - 1));
    }

    // After render: if active was in view, ensure it still is
    if (wasInView && lastRenderedLines.length > 0) {
      const newActiveIndex = lastRenderedLines.findIndex((line) => line.includes("◆"));
      if (newActiveIndex >= 0) {
        const newHeight = getEffectiveHeight();
        const newTotal = lastRenderedLines.length;
        const newScrollable = newTotal > newHeight;
        const newContentHeight = newScrollable ? newHeight - 1 : newHeight;
        const inViewNow =
          newActiveIndex >= viewportOffset &&
          newActiveIndex < viewportOffset + newContentHeight;
        if (!inViewNow) {
          // Scroll so active phase is at the top of viewport
          const maxOffset = Math.max(0, newTotal - newContentHeight);
          viewportOffset = Math.min(newActiveIndex, maxOffset);
          // Re-render with corrected offset
          renderTree(projectRoot);
        }
      }
    }
  });

  // Register signal handlers for clean exit on all termination paths
  for (const sig of CLEANUP_SIGNALS) {
    process.on(sig, () => void shutdown(watcher, gsdDir));
  }

  // Set up stdin in raw mode for quit key detection (qq, Esc Esc, Ctrl+C)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      // 1. Help overlay guard (D-15): when overlay is visible, only ?, Esc, Ctrl+C are active
      if (helpOverlayVisible) {
        if (chunk === "?" ) {
          // Toggle help off
          helpOverlayVisible = false;
          renderTree(projectRoot);
        } else if (chunk === "\x1b") {
          // Single Esc dismisses help overlay — MUST NOT reach parseQuitSequence (RESEARCH Pitfall 1)
          helpOverlayVisible = false;
          renderTree(projectRoot);
        } else if (chunk === "\x03") {
          // Ctrl+C — force quit
          void shutdown(watcher, gsdDir);
        }
        // All other keys ignored while overlay is visible
        return;
      }

      // 2. Navigation keys (j/k/h/l/g/G/?) — checked before arrow keys and quit (D-15)
      const navKey = parseNavKey(chunk);
      if (navKey !== null) {
        const height = getEffectiveHeight();
        const total = lastRenderedNodes.length;
        const scrollable = total > height;
        const contentHeight = scrollable ? height - 1 : height;

        switch (navKey) {
          case "cursor-down":
            cursorIndex = Math.min(cursorIndex + 1, lastRenderedNodes.length - 1);
            ensureCursorInViewport(cursorIndex, lastRenderedNodes.length, contentHeight);
            renderTree(projectRoot);
            break;
          case "cursor-up":
            cursorIndex = Math.max(cursorIndex - 1, 0);
            ensureCursorInViewport(cursorIndex, lastRenderedNodes.length, contentHeight);
            renderTree(projectRoot);
            break;
          case "collapse": {
            const node = lastRenderedNodes[cursorIndex];
            if (node?.kind === "phase" && node.dirName !== undefined) {
              collapsedPhases.add(node.dirName);
              // Clamp cursor after collapse (fewer visible nodes)
              cursorIndex = Math.max(0, Math.min(cursorIndex, lastRenderedNodes.length - 1));
            }
            renderTree(projectRoot);
            break;
          }
          case "expand": {
            const node = lastRenderedNodes[cursorIndex];
            if (node?.kind === "phase" && node.dirName !== undefined) {
              collapsedPhases.delete(node.dirName);
            }
            renderTree(projectRoot);
            break;
          }
          case "jump-top":
            cursorIndex = 0;
            ensureCursorInViewport(cursorIndex, lastRenderedNodes.length, contentHeight);
            renderTree(projectRoot);
            break;
          case "jump-bottom":
            cursorIndex = Math.max(0, lastRenderedNodes.length - 1);
            ensureCursorInViewport(cursorIndex, lastRenderedNodes.length, contentHeight);
            renderTree(projectRoot);
            break;
          case "help":
            helpOverlayVisible = true;
            renderTree(projectRoot);
            break;
        }
        return; // consumed — do NOT pass to arrow key or quit handler
      }

      // 3. Arrow keys MUST be checked before parseQuitSequence — their \x1b prefix must NOT reach quit state machine (Phase 4 Pattern)
      const arrow = parseArrowKey(chunk);
      if (arrow !== null) {
        const height = getEffectiveHeight();
        const total = lastRenderedLines.length;
        const scrollable = total > height;
        const contentHeight = scrollable ? height - 1 : height;
        scrollViewport(arrow === "up" ? -1 : 1, total, contentHeight);
        renderTree(projectRoot);
        return; // consumed — do NOT pass to parseQuitSequence
      }

      // 4. Quit sequences (qq, EscEsc, Ctrl+C)
      if (parseQuitSequence(chunk)) {
        void shutdown(watcher, gsdDir);
      }
    });
  }

  // Re-render on terminal resize — clamp viewport offset and cursor before re-render (Pitfall 4)
  process.stdout.on("resize", () => {
    const height = getEffectiveHeight();
    const total = lastRenderedLines.length;
    const scrollable = total > height;
    const contentHeight = scrollable ? height - 1 : height;
    const maxOffset = Math.max(0, total - contentHeight);
    if (viewportOffset > maxOffset) {
      viewportOffset = maxOffset;
    }
    // Clamp cursor index after resize (node count may change at new width)
    cursorIndex = Math.max(0, Math.min(cursorIndex, Math.max(0, lastRenderedNodes.length - 1)));
    renderTree(projectRoot);
  });
}
