/**
 * SessionManager — manages RpcClient lifecycle for daemon-driven GSD execution.
 *
 * Extends EventEmitter to emit typed session lifecycle events.
 * One active session per projectDir. Tracks events in a ring buffer,
 * detects blockers, tracks terminal state, and accumulates cost using
 * the cumulative-max pattern (K004).
 *
 * Adapted from packages/mcp-server/src/session-manager.ts with:
 * - Logger integration for structured logging
 * - EventEmitter for session lifecycle events
 * - getAllSessions() for cross-project status (R035)
 * - projectName field on ManagedSession
 */

import { execSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { RpcClient } from '@gsd-build/rpc-client';
import type { SdkAgentEvent, RpcInitResult, RpcCostUpdateEvent, RpcExtensionUIRequest } from '@gsd-build/rpc-client';
import type {
  ManagedSession,
  StartSessionOptions,
  PendingBlocker,
} from './types.js';
import { MAX_EVENTS, INIT_TIMEOUT_MS } from './types.js';
import type { Logger } from './logger.js';

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

export class SessionManager extends EventEmitter {
  /** Sessions keyed by resolved projectDir for duplicate-start prevention */
  private sessions = new Map<string, ManagedSession>();

  constructor(private readonly logger: Logger) {
    super();
  }

  /**
   * Start a new GSD auto-mode session for the given project directory.
   *
   * Rejects if a session already exists for this projectDir.
   * Creates an RpcClient, starts the process, performs the v2 init handshake,
   * wires event tracking, and sends '/gsd auto' to begin execution.
   */
  async startSession(options: StartSessionOptions): Promise<string> {
    const { projectDir } = options;

    if (!projectDir || projectDir.trim() === '') {
      throw new Error('projectDir is required and cannot be empty');
    }

    const resolvedDir = resolve(projectDir);
    const projectName = basename(resolvedDir);

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
      projectName,
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

      this.logger.info('session started', { sessionId: session.sessionId, projectDir: resolvedDir });
      this.emit('session:started', { sessionId: session.sessionId, projectDir: resolvedDir, projectName });

      return session.sessionId;
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);

      // Attempt cleanup
      try { await client.stop(); } catch { /* swallow cleanup errors */ }

      this.logger.error('session error', { sessionId: session.sessionId, projectDir: resolvedDir, error: session.error });
      this.emit('session:error', { sessionId: session.sessionId, projectDir: resolvedDir, projectName, error: session.error });

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
   * Return all tracked sessions (R035 — cross-project status).
   */
  getAllSessions(): ManagedSession[] {
    return Array.from(this.sessions.values());
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

    this.logger.info('blocker resolved', {
      sessionId,
      projectDir: session.projectDir,
      blockerId: blocker.id,
      blockerMethod: blocker.method,
    });
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

    this.logger.info('session cancelled', { sessionId, projectDir: session.projectDir });
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
      projectName: session.projectName,
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
    const envPath = process.env['GSD_CLI_PATH'];
    if (envPath) return resolve(envPath);

    try {
      const gsdBin = execSync('which gsd', { encoding: 'utf-8' }).trim();
      if (gsdBin) return resolve(gsdBin);
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

    // Forward event to listeners
    this.logger.debug('session event', { sessionId: session.sessionId, type: (event as Record<string, unknown>).type as string });
    this.emit('session:event', { sessionId: session.sessionId, projectDir: session.projectDir, event });

    // Cost tracking (K004 — cumulative-max)
    if ((event as Record<string, unknown>).type === 'cost_update') {
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
      if (isBlockedNotification(event as Record<string, unknown>)) {
        session.status = 'blocked';
        session.pendingBlocker = extractBlocker(event);
        this.logger.info('session blocked', {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          blockerId: session.pendingBlocker.id,
          blockerMethod: session.pendingBlocker.method,
        });
        this.emit('session:blocked', {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          projectName: session.projectName,
          blocker: session.pendingBlocker,
        });
      } else {
        session.status = 'completed';
        session.unsubscribe?.();
        this.logger.info('session completed', { sessionId: session.sessionId, projectDir: session.projectDir });
        this.emit('session:completed', {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          projectName: session.projectName,
        });
      }
      return;
    }

    // Blocker detection — non-fire-and-forget extension_ui_request
    if (isBlockingUIRequest(event as Record<string, unknown>)) {
      session.status = 'blocked';
      session.pendingBlocker = extractBlocker(event);
      this.logger.info('session blocked', {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        blockerId: session.pendingBlocker.id,
        blockerMethod: session.pendingBlocker.method,
      });
      this.emit('session:blocked', {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        projectName: session.projectName,
        blocker: session.pendingBlocker,
      });
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
