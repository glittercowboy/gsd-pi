/**
 * SessionManager — manages RpcClient lifecycle for background GSD execution.
 *
 * One active session per projectDir. Tracks events in a ring buffer,
 * detects blockers, tracks terminal state, and accumulates cost using
 * the cumulative-max pattern (K004).
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { RpcClient } from '@gsd-build/rpc-client';
import type { SdkAgentEvent, RpcInitResult, RpcCostUpdateEvent, RpcExtensionUIRequest } from '@gsd-build/rpc-client';
import type {
  ManagedSession,
  ExecuteOptions,
  PendingBlocker,
  CostAccumulator,
  SessionStatus,
} from './types.js';
import { MAX_EVENTS, INIT_TIMEOUT_MS } from './types.js';

// ---------------------------------------------------------------------------
// Inlined detection logic (from headless-events.ts — no internal package imports)
// ---------------------------------------------------------------------------

const FIRE_AND_FORGET_METHODS = new Set([
  'notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text',
]);

const TERMINAL_PREFIXES = ['auto-mode stopped', 'step-mode stopped'];

function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false;
  const message = String(event.message ?? '').toLowerCase();
  return TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false;
  const message = String(event.message ?? '').toLowerCase();
  return message.includes('blocked:');
}

function isBlockingUIRequest(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request') return false;
  const method = String(event.method ?? '');
  return !FIRE_AND_FORGET_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  /** Sessions keyed by projectDir for duplicate-start prevention */
  private sessions = new Map<string, ManagedSession>();

  /**
   * Start a new GSD auto-mode session for the given project directory.
   *
   * Rejects if a session already exists for this projectDir.
   * Creates an RpcClient, starts the process, performs the v2 init handshake,
   * wires event tracking, and sends '/gsd auto' to begin execution.
   */
  async startSession(projectDir: string, options: ExecuteOptions = {}): Promise<string> {
    if (!projectDir || projectDir.trim() === '') {
      throw new Error('projectDir is required and cannot be empty');
    }

    const resolvedDir = resolve(projectDir);

    const existing = this.sessions.get(resolvedDir);
    if (existing) {
      throw new Error(
        `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
      );
    }

    const cliPath = options.cliPath ?? SessionManager.resolveCLIPath();

    const args: string[] = ['--mode', 'rpc'];
    if (options.model) args.push('--model', options.model);
    if (options.bare) args.push('--bare');

    const client = new RpcClient({
      cliPath,
      cwd: resolvedDir,
      args,
    });

    // Build the session shell before async operations so we can track state
    const session: ManagedSession = {
      sessionId: '', // filled after init
      projectDir: resolvedDir,
      status: 'starting',
      client,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };

    // Insert into map early (keyed by dir) so concurrent starts are rejected
    this.sessions.set(resolvedDir, session);

    try {
      // Start the process with timeout
      await Promise.race([
        client.start(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.start() timed out after ${INIT_TIMEOUT_MS}ms`),
      ]);

      // Perform v2 init handshake
      const initResult: RpcInitResult = await Promise.race([
        client.init(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.init() timed out after ${INIT_TIMEOUT_MS}ms`),
      ]) as RpcInitResult;

      session.sessionId = initResult.sessionId;
      session.status = 'running';

      // Wire event tracking
      session.unsubscribe = client.onEvent((event: SdkAgentEvent) => {
        this.handleEvent(session, event);
      });

      // Kick off auto-mode
      const command = options.command ?? '/gsd auto';
      await client.prompt(command);

      return session.sessionId;
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);

      // Attempt cleanup
      try { await client.stop(); } catch { /* swallow cleanup errors */ }

      // Keep session in map so callers can inspect the error
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }

  /**
   * Look up a session by sessionId.
   * Linear scan is fine — we expect <10 concurrent sessions.
   */
  getSession(sessionId: string): ManagedSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  /**
   * Look up a session by project directory (direct map lookup).
   */
  getSessionByDir(projectDir: string): ManagedSession | undefined {
    return this.sessions.get(resolve(projectDir));
  }

  /**
   * Resolve a pending blocker by sending a UI response.
   */
  async resolveBlocker(sessionId: string, response: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!session.pendingBlocker) throw new Error(`No pending blocker for session ${sessionId}`);

    const blocker = session.pendingBlocker;
    session.client.sendUIResponse(blocker.id, { value: response });
    session.pendingBlocker = null;
    if (session.status === 'blocked') {
      session.status = 'running';
    }
  }

  /**
   * Cancel a running session — abort current operation then stop the process.
   */
  async cancelSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    try {
      await session.client.abort();
    } catch { /* may already be stopped */ }

    try {
      await session.client.stop();
    } catch { /* swallow */ }

    session.status = 'cancelled';
    session.unsubscribe?.();
  }

  /**
   * Build a HeadlessJsonResult-shaped object from accumulated session state.
   */
  getResult(sessionId: string): Record<string, unknown> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const durationMs = Date.now() - session.startTime;

    return {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      status: session.status,
      durationMs,
      cost: session.cost,
      recentEvents: session.events.slice(-10),
      pendingBlocker: session.pendingBlocker
        ? { id: session.pendingBlocker.id, method: session.pendingBlocker.method, message: session.pendingBlocker.message }
        : null,
      error: session.error ?? null,
    };
  }

  /**
   * Stop all active sessions and clean up resources.
   */
  async cleanup(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const session of this.sessions.values()) {
      session.unsubscribe?.();
      if (session.status === 'running' || session.status === 'starting' || session.status === 'blocked') {
        stopPromises.push(
          session.client.stop().catch(() => { /* swallow */ })
        );
        session.status = 'cancelled';
      }
    }

    await Promise.allSettled(stopPromises);
  }

  /**
   * Resolve the GSD CLI path.
   *
   * 1. GSD_CLI_PATH env var (highest priority)
   * 2. `which gsd` → resolve to the actual dist/cli.js
   */
  static resolveCLIPath(): string {
    // Check env var first
    const envPath = process.env['GSD_CLI_PATH'];
    if (envPath) return resolve(envPath);

    // Fallback: locate `gsd` via which
    try {
      const gsdBin = execSync('which gsd', { encoding: 'utf-8' }).trim();
      if (gsdBin) {
        // gsd bin is typically a symlink to dist/loader.js — return the resolved path
        return resolve(gsdBin);
      }
    } catch {
      // which failed
    }

    throw new Error(
      'Cannot find GSD CLI. Set GSD_CLI_PATH environment variable or ensure `gsd` is in PATH.'
    );
  }

  // ---------------------------------------------------------------------------
  // Private: Event Handling
  // ---------------------------------------------------------------------------

  private handleEvent(session: ManagedSession, event: SdkAgentEvent): void {
    // Ring buffer: push and trim
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }

    // Cost tracking (K004 — cumulative-max)
    if (event.type === 'cost_update') {
      const costEvent = event as unknown as RpcCostUpdateEvent;
      session.cost.totalCost = Math.max(session.cost.totalCost, costEvent.cumulativeCost ?? 0);
      if (costEvent.tokens) {
        session.cost.tokens.input = Math.max(session.cost.tokens.input, costEvent.tokens.input ?? 0);
        session.cost.tokens.output = Math.max(session.cost.tokens.output, costEvent.tokens.output ?? 0);
        session.cost.tokens.cacheRead = Math.max(session.cost.tokens.cacheRead, costEvent.tokens.cacheRead ?? 0);
        session.cost.tokens.cacheWrite = Math.max(session.cost.tokens.cacheWrite, costEvent.tokens.cacheWrite ?? 0);
      }
    }

    // Terminal detection — auto-mode/step-mode stopped
    if (isTerminalNotification(event as Record<string, unknown>)) {
      // Check if it's a blocked stop (not truly terminal — it's a blocker)
      if (isBlockedNotification(event as Record<string, unknown>)) {
        session.status = 'blocked';
        session.pendingBlocker = extractBlocker(event);
      } else {
        session.status = 'completed';
        session.unsubscribe?.();
      }
      return;
    }

    // Blocker detection — non-fire-and-forget extension_ui_request
    if (isBlockingUIRequest(event as Record<string, unknown>)) {
      session.status = 'blocked';
      session.pendingBlocker = extractBlocker(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function extractBlocker(event: SdkAgentEvent): PendingBlocker {
  const uiEvent = event as unknown as RpcExtensionUIRequest;
  return {
    id: String(uiEvent.id ?? ''),
    method: String(uiEvent.method ?? ''),
    message: String((uiEvent as Record<string, unknown>).title ?? (uiEvent as Record<string, unknown>).message ?? ''),
    event: uiEvent,
  };
}
