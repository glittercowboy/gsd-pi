/**
 * Shutdown gate — defers process.exit() so that page refreshes (which fire
 * `pagehide` then immediately re-boot) don't kill the server.
 *
 * Flow:
 *   pagehide → POST /api/shutdown → scheduleShutdown() → timer starts
 *   refresh  → GET  /api/boot     → cancelShutdown()   → timer cleared
 *   tab close → timer fires → process.exit(0)
 *
 * When GSD_WEB_DAEMON_MODE=1, the server is running as a persistent daemon
 * (e.g. behind a reverse proxy for remote access). In this mode,
 * scheduleShutdown() is a no-op — no client tab should be able to exit the
 * server. The /api/shutdown endpoint still returns { ok: true } so the
 * client beacon doesn't produce a network error.
 */

const SHUTDOWN_DELAY_MS = 3_000;

let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Returns true when the server is running in daemon mode.
 * In daemon mode, shutdown requests from browser tabs are ignored.
 */
export function isDaemonMode(): boolean {
  return process.env.GSD_WEB_DAEMON_MODE === "1";
}

/**
 * Schedule a graceful process exit after SHUTDOWN_DELAY_MS.
 * If cancelShutdown() is called before the timer fires (e.g. a page refresh
 * triggers a boot request), the exit is aborted.
 *
 * No-op when GSD_WEB_DAEMON_MODE=1 — the server should outlive any
 * individual browser session.
 */
export function scheduleShutdown(): void {
  if (isDaemonMode()) {
    return;
  }

  // Don't stack timers — reset if already scheduled
  if (shutdownTimer !== null) {
    clearTimeout(shutdownTimer);
  }

  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    process.exit(0);
  }, SHUTDOWN_DELAY_MS);
}

/**
 * Cancel a pending shutdown. Called by any incoming API request that proves
 * the client is still alive (boot, SSE reconnect, etc.).
 */
export function cancelShutdown(): void {
  if (shutdownTimer !== null) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

/**
 * Check whether a shutdown is currently pending.
 */
export function isShutdownPending(): boolean {
  return shutdownTimer !== null;
}
