// GSD Watch — Renderer subprocess entry point: signal wiring, quit key detection, placeholder rendering
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startPlanningWatcher } from "./watcher.js";
import { clearWatchLock } from "./orchestrator.js";
import { gsdRoot } from "../paths.js";
import type { FSWatcher } from "chokidar";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Signals that should trigger cleanup and graceful exit. */
export const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];

/** Minimum PTY width to guard against zero-width pane at startup (Pitfall 2). */
const MIN_WIDTH = 40;

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

  // Render initial placeholder
  renderPlaceholder(projectRoot);

  // Start file watcher — Phase 3 replaces this callback with tree rendering
  const watcher = startPlanningWatcher(planningDir, () =>
    renderPlaceholder(projectRoot)
  );

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
      if (parseQuitSequence(chunk)) {
        void shutdown(watcher, gsdDir);
      }
    });
  }

  // Re-render on terminal resize
  process.stdout.on("resize", () => renderPlaceholder(projectRoot));
}
