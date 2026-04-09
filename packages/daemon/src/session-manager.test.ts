/**
 * SessionManager unit tests.
 *
 * Uses the MockRpcClient + TestableSessionManager pattern (K008) to test
 * session lifecycle, event handling, cost tracking, blocker detection,
 * and cleanup without spawning real GSD processes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, basename } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from './session-manager.js';
import { MAX_EVENTS } from './types.js';
import type { ManagedSession, PendingBlocker } from './types.js';
import { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Mock RpcClient (duck-typed to match RpcClient interface)
// ---------------------------------------------------------------------------

class MockRpcClient {
  started = false;
  stopped = false;
  aborted = false;
  prompted: string[] = [];
  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  uiResponses: Array<{ requestId: string; response: Record<string, unknown> }> = [];

  /** Control — set to make start() reject */
  startError: Error | null = null;
  /** Control — set to make init() reject */
  initError: Error | null = null;
  /** Control — override sessionId from init */
  initSessionId = 'mock-session-001';

  cwd: string;
  args: string[];

  constructor(options?: Record<string, unknown>) {
    this.cwd = (options?.cwd as string) ?? '';
    this.args = (options?.args as string[]) ?? [];
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async init(): Promise<{ sessionId: string; version: string }> {
    if (this.initError) throw this.initError;
    return { sessionId: this.initSessionId, version: '2.51.0' };
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  async prompt(message: string): Promise<void> {
    this.prompted.push(message);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  sendUIResponse(requestId: string, response: Record<string, unknown>): void {
    this.uiResponses.push({ requestId, response });
  }

  /** Test helper — emit an event to all listeners */
  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// TestableSessionManager — injects mock clients without module mocking (K008)
// ---------------------------------------------------------------------------

class TestableSessionManager extends SessionManager {
  lastClient: MockRpcClient | null = null;
  allClients: MockRpcClient[] = [];
  private sessionCounter = 0;
  nextInitError: Error | null = null;
  nextStartError: Error | null = null;

  override async startSession(options: { projectDir: string; command?: string; model?: string; bare?: boolean; cliPath?: string }): Promise<string> {
    const { projectDir } = options;

    if (!projectDir || projectDir.trim() === '') {
      throw new Error('projectDir is required and cannot be empty');
    }

    const resolvedDir = resolve(projectDir);
    const projectName = basename(resolvedDir);

    // Check duplicate via getSessionByDir
    const existing = this.getSessionByDir(resolvedDir);
    if (existing) {
      throw new Error(
        `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
      );
    }

    const client = new MockRpcClient({ cwd: resolvedDir, args: [] });
    if (this.nextStartError) {
      client.startError = this.nextStartError;
      this.nextStartError = null;
    }
    if (this.nextInitError) {
      client.initError = this.nextInitError;
      this.nextInitError = null;
    }

    this.sessionCounter++;
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, '0')}`;
    this.lastClient = client;
    this.allClients.push(client);

    // Build session shell
    const session: ManagedSession = {
      sessionId: '',
      projectDir: resolvedDir,
      projectName,
      status: 'starting',
      client: client as any, // duck-typed mock
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };

    // Insert into internal sessions map
    (this as any).sessions.set(resolvedDir, session);

    try {
      await client.start();

      const initResult = await client.init();
      session.sessionId = initResult.sessionId;
      session.status = 'running';

      // Wire event tracking using parent's handleEvent
      session.unsubscribe = client.onEvent((event: Record<string, unknown>) => {
        (this as any).handleEvent(session, event);
      });

      // Kick off auto-mode
      const command = options.command ?? '/gsd auto';
      await client.prompt(command);

      // Emit lifecycle events (matching parent behavior)
      (this as any).logger.info('session started', { sessionId: session.sessionId, projectDir: resolvedDir });
      this.emit('session:started', { sessionId: session.sessionId, projectDir: resolvedDir, projectName });

      return session.sessionId;
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      try { await client.stop(); } catch { /* swallow */ }

      (this as any).logger.error('session error', { sessionId: session.sessionId, projectDir: resolvedDir, error: session.error });
      this.emit('session:error', { sessionId: session.sessionId, projectDir: resolvedDir, projectName, error: session.error });

      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Logger spy helper
// ---------------------------------------------------------------------------

interface LogCall {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

class SpyLogger {
  calls: LogCall[] = [];
  private tmpDir: string;
  logger: Logger;

  constructor() {
    this.tmpDir = mkdtempSync(join(tmpdir(), 'sm-test-'));
    this.logger = new Logger({
      filePath: join(this.tmpDir, 'test.log'),
      level: 'debug',
    });

    // Intercept write calls by wrapping the logger methods
    const original = {
      debug: this.logger.debug.bind(this.logger),
      info: this.logger.info.bind(this.logger),
      warn: this.logger.warn.bind(this.logger),
      error: this.logger.error.bind(this.logger),
    };

    this.logger.debug = (msg: string, data?: Record<string, unknown>) => {
      this.calls.push({ level: 'debug', msg, data });
      original.debug(msg, data);
    };
    this.logger.info = (msg: string, data?: Record<string, unknown>) => {
      this.calls.push({ level: 'info', msg, data });
      original.info(msg, data);
    };
    this.logger.warn = (msg: string, data?: Record<string, unknown>) => {
      this.calls.push({ level: 'warn', msg, data });
      original.warn(msg, data);
    };
    this.logger.error = (msg: string, data?: Record<string, unknown>) => {
      this.calls.push({ level: 'error', msg, data });
      original.error(msg, data);
    };
  }

  async cleanup(): Promise<void> {
    await this.logger.close();
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  findCalls(level: string, msgSubstring: string): LogCall[] {
    return this.calls.filter(c => c.level === level && c.msg.includes(msgSubstring));
  }
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

let allManagers: TestableSessionManager[] = [];
let allSpyLoggers: SpyLogger[] = [];

function createManager(): { manager: TestableSessionManager; spy: SpyLogger } {
  const spy = new SpyLogger();
  const manager = new TestableSessionManager(spy.logger);
  allManagers.push(manager);
  allSpyLoggers.push(spy);
  return { manager, spy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  afterEach(async () => {
    for (const m of allManagers) {
      try { await m.cleanup(); } catch { /* swallow */ }
    }
    allManagers = [];
    for (const s of allSpyLoggers) {
      await s.cleanup();
    }
    allSpyLoggers = [];
  });

  // ---- Lifecycle: start → running → completed ----

  it('start → running → completed lifecycle', async () => {
    const { manager, spy } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/test-project' });
    assert.ok(sessionId);

    const session = manager.getSession(sessionId);
    assert.ok(session);
    assert.equal(session.status, 'running');
    assert.equal(session.projectName, 'test-project');

    // Simulate terminal notification
    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'n1',
      method: 'notify',
      message: 'Auto-mode stopped: completed all tasks',
    });

    assert.equal(session.status, 'completed');

    // Verify logger calls
    const startedLogs = spy.findCalls('info', 'session started');
    assert.equal(startedLogs.length, 1);
    const completedLogs = spy.findCalls('info', 'session completed');
    assert.equal(completedLogs.length, 1);
  });

  // ---- Lifecycle: start → running → blocked → resolve → running → completed ----

  it('start → blocked → resolve → running → completed lifecycle', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/test-project-2' });
    const session = manager.getSession(sessionId)!;

    // Simulate blocking UI request (non-fire-and-forget method)
    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'blocker-1',
      method: 'confirm',
      title: 'Merge PR?',
      message: 'Should I merge this PR?',
    });

    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker!.id, 'blocker-1');
    assert.equal(session.pendingBlocker!.method, 'confirm');

    // Resolve the blocker
    await manager.resolveBlocker(sessionId, 'yes');

    assert.equal(session.status, 'running');
    assert.equal(session.pendingBlocker, null);

    // Verify UI response was sent
    const client = manager.lastClient!;
    assert.equal(client.uiResponses.length, 1);
    assert.equal(client.uiResponses[0].requestId, 'blocker-1');

    // Complete the session
    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'n2',
      method: 'notify',
      message: 'Auto-mode stopped: all done',
    });

    assert.equal(session.status, 'completed');
  });

  // ---- Lifecycle: start → error (init failure) ----

  it('start → error when init fails', async () => {
    const { manager, spy } = createManager();

    manager.nextInitError = new Error('Connection refused');

    await assert.rejects(
      () => manager.startSession({ projectDir: '/tmp/test-error-project' }),
      (err: Error) => {
        assert.ok(err.message.includes('Connection refused'));
        return true;
      }
    );

    // Session should still exist in map with error status
    const session = manager.getSessionByDir('/tmp/test-error-project');
    assert.ok(session);
    assert.equal(session.status, 'error');
    assert.ok(session.error?.includes('Connection refused'));

    // Logger should have error call
    const errorLogs = spy.findCalls('error', 'session error');
    assert.equal(errorLogs.length, 1);
  });

  // ---- Duplicate session prevention ----

  it('rejects duplicate session for same projectDir', async () => {
    const { manager } = createManager();

    await manager.startSession({ projectDir: '/tmp/dup-test' });

    await assert.rejects(
      () => manager.startSession({ projectDir: '/tmp/dup-test' }),
      (err: Error) => {
        assert.ok(err.message.includes('Session already active'));
        return true;
      }
    );
  });

  // ---- Cancel session ----

  it('cancels a running session', async () => {
    const { manager, spy } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/cancel-test' });
    const session = manager.getSession(sessionId)!;
    const client = manager.lastClient!;

    await manager.cancelSession(sessionId);

    assert.equal(session.status, 'cancelled');
    assert.ok(client.aborted);
    assert.ok(client.stopped);

    const cancelLogs = spy.findCalls('info', 'session cancelled');
    assert.equal(cancelLogs.length, 1);
  });

  // ---- Cost accumulation (K004 cumulative-max) ----

  it('accumulates cost using cumulative-max pattern (K004)', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/cost-test' });
    const session = manager.getSession(sessionId)!;
    const client = manager.lastClient!;

    // First cost update
    client.emitEvent({
      type: 'cost_update',
      runId: 'run-1',
      turnCost: 0.01,
      cumulativeCost: 0.01,
      tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
    });

    assert.equal(session.cost.totalCost, 0.01);
    assert.equal(session.cost.tokens.input, 100);

    // Second cost update — cumulative values should increase
    client.emitEvent({
      type: 'cost_update',
      runId: 'run-1',
      turnCost: 0.02,
      cumulativeCost: 0.03,
      tokens: { input: 250, output: 120, cacheRead: 40, cacheWrite: 20 },
    });

    assert.equal(session.cost.totalCost, 0.03);
    assert.equal(session.cost.tokens.input, 250);
    assert.equal(session.cost.tokens.output, 120);

    // Third update with lower values — max should hold
    client.emitEvent({
      type: 'cost_update',
      runId: 'run-2',
      turnCost: 0.005,
      cumulativeCost: 0.02, // lower than 0.03 — should NOT replace
      tokens: { input: 50, output: 30, cacheRead: 5, cacheWrite: 2 },
    });

    assert.equal(session.cost.totalCost, 0.03); // max held
    assert.equal(session.cost.tokens.input, 250); // max held
  });

  // ---- Ring buffer event trimming ----

  it('trims events when exceeding MAX_EVENTS', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/ringbuf-test' });
    const session = manager.getSession(sessionId)!;
    const client = manager.lastClient!;

    // Push MAX_EVENTS + 20 events
    for (let i = 0; i < MAX_EVENTS + 20; i++) {
      client.emitEvent({
        type: 'assistant_message',
        id: `msg-${i}`,
        content: `Event ${i}`,
      });
    }

    assert.equal(session.events.length, MAX_EVENTS);
    // Oldest events should be trimmed — first event should be #20
    const firstEvent = session.events[0] as Record<string, unknown>;
    assert.equal(firstEvent.id, 'msg-20');
  });

  // ---- Blocker detection (non-fire-and-forget extension_ui_request) ----

  it('detects blocker from non-fire-and-forget extension_ui_request', async () => {
    const { manager, spy } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/blocker-test' });
    const session = manager.getSession(sessionId)!;

    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'sel-1',
      method: 'select',
      title: 'Choose deployment target',
      options: ['staging', 'production'],
    });

    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker!.method, 'select');

    const blockedLogs = spy.findCalls('info', 'session blocked');
    assert.equal(blockedLogs.length, 1);
  });

  // ---- Fire-and-forget methods do NOT block ----

  it('fire-and-forget methods do not trigger blocker', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/faf-test' });
    const session = manager.getSession(sessionId)!;

    // setStatus is fire-and-forget
    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'st-1',
      method: 'setStatus',
      statusKey: 'build',
      statusText: 'Building...',
    });

    assert.equal(session.status, 'running');
    assert.equal(session.pendingBlocker, null);
  });

  // ---- Terminal detection (auto-mode stopped notification) ----

  it('detects terminal from auto-mode stopped notification', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/terminal-test' });
    const session = manager.getSession(sessionId)!;

    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'n1',
      method: 'notify',
      message: 'Step-mode stopped: user requested',
    });

    assert.equal(session.status, 'completed');
  });

  // ---- getAllSessions returns all tracked sessions ----

  it('getAllSessions returns all tracked sessions', async () => {
    const { manager } = createManager();

    await manager.startSession({ projectDir: '/tmp/proj-a' });
    await manager.startSession({ projectDir: '/tmp/proj-b' });
    await manager.startSession({ projectDir: '/tmp/proj-c' });

    const all = manager.getAllSessions();
    assert.equal(all.length, 3);

    const dirs = all.map(s => s.projectDir).sort();
    assert.ok(dirs[0].endsWith('proj-a'));
    assert.ok(dirs[1].endsWith('proj-b'));
    assert.ok(dirs[2].endsWith('proj-c'));
  });

  // ---- cleanup stops all active sessions ----

  it('cleanup stops all active sessions', async () => {
    const { manager } = createManager();

    await manager.startSession({ projectDir: '/tmp/cleanup-a' });
    await manager.startSession({ projectDir: '/tmp/cleanup-b' });

    const clients = [...manager.allClients];
    assert.equal(clients.length, 2);

    await manager.cleanup();

    const all = manager.getAllSessions();
    for (const s of all) {
      assert.equal(s.status, 'cancelled');
    }
    // Both clients should have been stopped
    for (const c of clients) {
      assert.ok(c.stopped);
    }
  });

  // ---- EventEmitter: session:started ----

  it('emits session:started event', async () => {
    const { manager } = createManager();

    let emittedData: Record<string, unknown> | undefined;
    manager.on('session:started', (data: Record<string, unknown>) => { emittedData = data; });

    const sessionId = await manager.startSession({ projectDir: '/tmp/emit-start' });

    assert.ok(emittedData);
    assert.equal(emittedData.sessionId, sessionId);
    assert.equal(emittedData.projectName, 'emit-start');
  });

  // ---- EventEmitter: session:blocked ----

  it('emits session:blocked event', async () => {
    const { manager } = createManager();

    let emittedData: Record<string, unknown> | undefined;
    manager.on('session:blocked', (data: Record<string, unknown>) => { emittedData = data; });

    await manager.startSession({ projectDir: '/tmp/emit-blocked' });

    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'b-1',
      method: 'input',
      title: 'Enter API key',
    });

    assert.ok(emittedData);
    assert.equal((emittedData.blocker as PendingBlocker).id, 'b-1');
  });

  // ---- EventEmitter: session:completed ----

  it('emits session:completed event', async () => {
    const { manager } = createManager();

    let emittedData: Record<string, unknown> | undefined;
    manager.on('session:completed', (data: Record<string, unknown>) => { emittedData = data; });

    await manager.startSession({ projectDir: '/tmp/emit-completed' });

    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'n1',
      method: 'notify',
      message: 'Auto-mode stopped: success',
    });

    assert.ok(emittedData);
    assert.equal(emittedData.projectName, 'emit-completed');
  });

  // ---- EventEmitter: session:error ----

  it('emits session:error event on init failure', async () => {
    const { manager } = createManager();

    let emittedData: Record<string, unknown> | undefined;
    manager.on('session:error', (data: Record<string, unknown>) => { emittedData = data; });

    manager.nextInitError = new Error('Process crashed');

    try {
      await manager.startSession({ projectDir: '/tmp/emit-error' });
    } catch { /* expected */ }

    assert.ok(emittedData);
    assert.ok((emittedData.error as string).includes('Process crashed'));
  });

  // ---- EventEmitter: session:event ----

  it('emits session:event for every forwarded event', async () => {
    const { manager } = createManager();

    const events: Record<string, unknown>[] = [];
    manager.on('session:event', (data) => { events.push(data); });

    await manager.startSession({ projectDir: '/tmp/emit-event' });

    manager.lastClient!.emitEvent({ type: 'assistant_message', id: 'a1', content: 'Hello' });
    manager.lastClient!.emitEvent({ type: 'tool_use', id: 't1', name: 'read' });

    assert.equal(events.length, 2);
  });

  // ---- Empty projectDir rejection ----

  it('rejects empty projectDir', async () => {
    const { manager } = createManager();

    await assert.rejects(
      () => manager.startSession({ projectDir: '' }),
      (err: Error) => {
        assert.ok(err.message.includes('projectDir is required'));
        return true;
      }
    );

    await assert.rejects(
      () => manager.startSession({ projectDir: '   ' }),
      (err: Error) => {
        assert.ok(err.message.includes('projectDir is required'));
        return true;
      }
    );
  });

  // ---- Logger receives structured calls ----

  it('logger receives structured calls during lifecycle', async () => {
    const { manager, spy } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/log-test' });

    // Should have 'session started' info log
    const started = spy.findCalls('info', 'session started');
    assert.equal(started.length, 1);
    assert.ok(started[0].data?.sessionId);
    assert.ok(started[0].data?.projectDir);

    // Emit an event — should produce debug log
    manager.lastClient!.emitEvent({ type: 'assistant_message', id: 'a1', content: 'hi' });
    const debugLogs = spy.findCalls('debug', 'session event');
    assert.ok(debugLogs.length >= 1);
    assert.ok(debugLogs[0].data?.type);
  });

  // ---- getResult returns structured status ----

  it('getResult returns structured status', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/result-test' });
    const result = manager.getResult(sessionId);

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.status, 'running');
    assert.equal(result.projectName, 'result-test');
    assert.equal(result.error, null);
    assert.equal(result.pendingBlocker, null);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.cost);
    assert.ok(Array.isArray(result.recentEvents));
  });

  // ---- getResult throws for unknown session ----

  it('getResult throws for unknown sessionId', () => {
    const { manager } = createManager();

    assert.throws(
      () => manager.getResult('nonexistent'),
      (err: Error) => err.message.includes('Session not found')
    );
  });

  // ---- resolveBlocker throws when no blocker pending ----

  it('resolveBlocker throws when no blocker pending', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/no-blocker' });

    await assert.rejects(
      () => manager.resolveBlocker(sessionId, 'yes'),
      (err: Error) => err.message.includes('No pending blocker')
    );
  });

  // ---- cancelSession throws for unknown session ----

  it('cancelSession throws for unknown sessionId', async () => {
    const { manager } = createManager();

    await assert.rejects(
      () => manager.cancelSession('nonexistent'),
      (err: Error) => err.message.includes('Session not found')
    );
  });

  // ---- Blocked notification detected as blocker, not terminal ----

  it('blocked notification sets status to blocked, not completed', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/tmp/blocked-notify' });
    const session = manager.getSession(sessionId)!;

    manager.lastClient!.emitEvent({
      type: 'extension_ui_request',
      id: 'bn-1',
      method: 'notify',
      message: 'Auto-mode stopped: Blocked: waiting for approval',
    });

    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
  });

  // ---- projectName is basename of resolved projectDir ----

  it('projectName is basename of projectDir', async () => {
    const { manager } = createManager();

    const sessionId = await manager.startSession({ projectDir: '/home/user/projects/my-app' });
    const session = manager.getSession(sessionId)!;

    assert.equal(session.projectName, 'my-app');
  });

  // ---- Custom command is sent instead of default ----

  it('sends custom command when provided', async () => {
    const { manager } = createManager();

    await manager.startSession({ projectDir: '/tmp/custom-cmd', command: '/gsd quick fix-typo' });
    const client = manager.lastClient!;

    assert.ok(client.prompted.includes('/gsd quick fix-typo'));
    assert.ok(!client.prompted.includes('/gsd auto'));
  });

  // ---- getSessionByDir returns session by directory lookup ----

  it('getSessionByDir returns session by directory', async () => {
    const { manager } = createManager();

    await manager.startSession({ projectDir: '/tmp/dir-lookup' });
    const session = manager.getSessionByDir('/tmp/dir-lookup');

    assert.ok(session);
    assert.equal(session.projectName, 'dir-lookup');
  });
});
