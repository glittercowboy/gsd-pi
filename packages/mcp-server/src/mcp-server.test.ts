/**
 * @gsd-build/mcp-server — Integration and unit tests.
 *
 * Strategy: We cannot mock @gsd-build/rpc-client at the module level without
 * --experimental-test-module-mocks. Instead we test by:
 *
 * 1. Subclassing SessionManager to inject a mock client factory
 * 2. Testing event handling, state transitions, and error paths
 * 3. Testing tool registration via createMcpServer
 * 4. Testing CLI path resolution via static method
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';

import { SessionManager } from './session-manager.js';
import {
  buildAskUserQuestionsElicitRequest,
  createMcpServer,
  formatAskUserQuestionsElicitResult,
  withElicitTimeout,
} from './server.js';
import { MAX_EVENTS } from './types.js';
import type { ManagedSession, CostAccumulator, PendingBlocker } from './types.js';

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
// TestableSessionManager — injects mock clients without module mocking
// ---------------------------------------------------------------------------

/**
 * Subclass that overrides startSession to use MockRpcClient instead of the
 * real RpcClient. We directly construct the session object, mirroring the
 * parent's logic but with our mock.
 */
class TestableSessionManager extends SessionManager {
  /** The last mock client created */
  lastClient: MockRpcClient | null = null;
  /** All mock clients */
  allClients: MockRpcClient[] = [];
  /** Counter for unique session IDs across multiple sessions */
  private sessionCounter = 0;
  /** Control: set to make startSession fail during init */
  nextInitError: Error | null = null;
  /** Control: set to make startSession fail during start */
  nextStartError: Error | null = null;

  override async startSession(projectDir: string, options: { cliPath?: string; command?: string; model?: string; bare?: boolean } = {}): Promise<string> {
    if (!projectDir || projectDir.trim() === '') {
      throw new Error('projectDir is required and cannot be empty');
    }

    const resolvedDir = resolve(projectDir);

    // Mirror the real SessionManager (#4476): only block when a genuinely
    // active session is running. Terminal states are evicted.
    const existing = this.getSessionByDir(resolvedDir);
    if (existing) {
      if (existing.status === 'starting' || existing.status === 'running' || existing.status === 'blocked') {
        throw new Error(
          `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
        );
      }
      existing.unsubscribe?.();
      (this as any).sessions.delete(resolvedDir);
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

    // Create the session shell
    const session: ManagedSession = {
      sessionId: '',
      projectDir: resolvedDir,
      status: 'starting',
      client: client as any, // duck-typed mock
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };

    // Insert into internal sessions map — access via protected method
    this._putSession(resolvedDir, session);

    try {
      await client.start();

      const initResult = await client.init();
      session.sessionId = initResult.sessionId;
      session.status = 'running';

      // Wire event tracking using the same handleEvent logic as parent
      session.unsubscribe = client.onEvent((event: Record<string, unknown>) => {
        this._handleEvent(session, event);
      });

      // Kick off auto-mode
      const command = options.command ?? '/gsd auto';
      await client.prompt(command);

      return session.sessionId;
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      try { await client.stop(); } catch { /* swallow */ }
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }

  /** Expose internal session map insertion for testing */
  _putSession(key: string, session: ManagedSession): void {
    // Access the private sessions map via any cast
    (this as any).sessions.set(key, session);
  }

  /** Expose handleEvent for testing */
  _handleEvent(session: ManagedSession, event: Record<string, unknown>): void {
    (this as any).handleEvent(session, event);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let allManagers: TestableSessionManager[] = [];

function createManager(): TestableSessionManager {
  const mgr = new TestableSessionManager();
  allManagers.push(mgr);
  return mgr;
}

// ---------------------------------------------------------------------------
// SessionManager unit tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let sm: TestableSessionManager;

  beforeEach(() => {
    sm = createManager();
  });

  afterEach(async () => {
    for (const mgr of allManagers) {
      await mgr.cleanup();
    }
    allManagers = [];
  });

  it('startSession creates session and returns sessionId', async () => {
    const sessionId = await sm.startSession('/tmp/test-project', { cliPath: '/usr/bin/gsd' });
    assert.equal(sessionId, 'mock-session-001');

    const session = sm.getSession(sessionId);
    assert.ok(session);
    assert.equal(session.status, 'running');
    assert.equal(session.projectDir, resolve('/tmp/test-project'));
  });

  it('startSession sends /gsd auto by default', async () => {
    await sm.startSession('/tmp/test-prompt', { cliPath: '/usr/bin/gsd' });
    assert.ok(sm.lastClient);
    assert.deepEqual(sm.lastClient.prompted, ['/gsd auto']);
  });

  it('startSession sends custom command when provided', async () => {
    await sm.startSession('/tmp/test-cmd', { cliPath: '/usr/bin/gsd', command: '/gsd auto --resume' });
    assert.ok(sm.lastClient);
    assert.deepEqual(sm.lastClient.prompted, ['/gsd auto --resume']);
  });

  it('startSession rejects duplicate projectDir', async () => {
    await sm.startSession('/tmp/dup-test', { cliPath: '/usr/bin/gsd' });
    await assert.rejects(
      () => sm.startSession('/tmp/dup-test', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('Session already active'));
        return true;
      },
    );
  });

  // #4476: terminal-state sessions (completed/error/cancelled) are evicted so
  // the same projectDir can host a fresh session — only starting/running/blocked
  // sessions block re-entry.
  for (const terminalStatus of ['completed', 'error', 'cancelled'] as const) {
    it(`startSession evicts a prior '${terminalStatus}' session for the same projectDir`, async () => {
      const dir = `/tmp/evict-${terminalStatus}`;
      const firstSessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
      const first = sm.getSession(firstSessionId)!;
      first.status = terminalStatus;

      // Should not throw — terminal session is evicted, fresh one starts.
      const secondSessionId = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
      assert.notEqual(secondSessionId, firstSessionId);
      const second = sm.getSession(secondSessionId)!;
      assert.equal(second.status, 'running');
      assert.equal(sm.getSessionByDir(dir)!.sessionId, secondSessionId);
    });
  }

  for (const activeStatus of ['starting', 'running', 'blocked'] as const) {
    it(`startSession still rejects a prior '${activeStatus}' session`, async () => {
      const dir = `/tmp/keep-${activeStatus}`;
      const sid = await sm.startSession(dir, { cliPath: '/usr/bin/gsd' });
      sm.getSession(sid)!.status = activeStatus;
      await assert.rejects(
        () => sm.startSession(dir, { cliPath: '/usr/bin/gsd' }),
        /Session already active/,
      );
    });
  }

  it('startSession rejects empty projectDir', async () => {
    await assert.rejects(
      () => sm.startSession('', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('projectDir is required'));
        return true;
      },
    );
  });

  it('startSession sets error status on start() failure', async () => {
    sm.nextStartError = new Error('spawn failed');

    await assert.rejects(
      () => sm.startSession('/tmp/fail-start', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to start session'));
        assert.ok(err.message.includes('spawn failed'));
        return true;
      },
    );
  });

  it('startSession sets error status on init() failure', async () => {
    sm.nextInitError = new Error('handshake failed');

    await assert.rejects(
      () => sm.startSession('/tmp/fail-init', { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to start session'));
        assert.ok(err.message.includes('handshake failed'));
        return true;
      },
    );
  });

  it('getSession returns undefined for unknown sessionId', () => {
    const result = sm.getSession('nonexistent-id');
    assert.equal(result, undefined);
  });

  it('getSessionByDir returns session for known dir', async () => {
    await sm.startSession('/tmp/by-dir', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSessionByDir('/tmp/by-dir');
    assert.ok(session);
    assert.equal(session.sessionId, 'mock-session-001');
  });

  it('resolveBlocker errors when no pending blocker', async () => {
    const sessionId = await sm.startSession('/tmp/no-blocker', { cliPath: '/usr/bin/gsd' });
    await assert.rejects(
      () => sm.resolveBlocker(sessionId, 'some response'),
      (err: Error) => {
        assert.ok(err.message.includes('No pending blocker'));
        return true;
      },
    );
  });

  it('resolveBlocker errors for unknown session', async () => {
    await assert.rejects(
      () => sm.resolveBlocker('unknown-session', 'some response'),
      (err: Error) => {
        assert.ok(err.message.includes('Session not found'));
        return true;
      },
    );
  });

  it('resolveBlocker clears pendingBlocker and sends UI response', async () => {
    const sessionId = await sm.startSession('/tmp/blocker-resolve', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    // Simulate a blocking UI request event
    client.emitEvent({
      type: 'extension_ui_request',
      id: 'req-42',
      method: 'select',
      title: 'Pick an option',
    });

    const session = sm.getSession(sessionId)!;
    assert.ok(session.pendingBlocker);
    assert.equal(session.status, 'blocked');

    // Resolve the blocker
    await sm.resolveBlocker(sessionId, 'option-a');

    assert.equal(session.pendingBlocker, null);
    assert.equal(session.status, 'running');
    assert.equal(client.uiResponses.length, 1);
    assert.equal(client.uiResponses[0].requestId, 'req-42');
  });

  it('cancelSession calls abort + stop on client', async () => {
    const sessionId = await sm.startSession('/tmp/cancel-test', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    await sm.cancelSession(sessionId);

    assert.ok(client.aborted);
    assert.ok(client.stopped);

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'cancelled');
  });

  it('cancelSession errors for unknown session', async () => {
    await assert.rejects(
      () => sm.cancelSession('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Session not found'));
        return true;
      },
    );
  });

  it('cleanup stops all active sessions', async () => {
    await sm.startSession('/tmp/cleanup-1', { cliPath: '/usr/bin/gsd' });
    await sm.startSession('/tmp/cleanup-2', { cliPath: '/usr/bin/gsd' });

    assert.equal(sm.allClients.length, 2);

    await sm.cleanup();

    for (const client of sm.allClients) {
      assert.ok(client.stopped, 'Client should be stopped after cleanup');
    }
  });

  it('event ring buffer caps at MAX_EVENTS', async () => {
    const sessionId = await sm.startSession('/tmp/ring-buffer', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    for (let i = 0; i < MAX_EVENTS + 20; i++) {
      client.emitEvent({ type: 'tool_use', index: i });
    }

    const session = sm.getSession(sessionId)!;
    assert.equal(session.events.length, MAX_EVENTS);
    // Oldest events trimmed — first event index should be 20
    assert.equal((session.events[0] as Record<string, unknown>).index, 20);
  });

  it('blocker detection: non-fire-and-forget extension_ui_request sets pendingBlocker', async () => {
    const sessionId = await sm.startSession('/tmp/blocker-detect', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    // 'select' is not in FIRE_AND_FORGET_METHODS
    client.emitEvent({
      type: 'extension_ui_request',
      id: 'req-99',
      method: 'select',
      title: 'Choose wisely',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker.id, 'req-99');
    assert.equal(session.pendingBlocker.method, 'select');
  });

  it('fire-and-forget methods do not set pendingBlocker', async () => {
    const sessionId = await sm.startSession('/tmp/fire-forget', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    // 'notify' is fire-and-forget — on its own (no terminal prefix) should not block
    client.emitEvent({
      type: 'extension_ui_request',
      id: 'req-100',
      method: 'notify',
      message: 'Just a notification',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'running');
    assert.equal(session.pendingBlocker, null);
  });

  it('terminal detection: auto-mode stopped sets status to completed', async () => {
    const sessionId = await sm.startSession('/tmp/terminal', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode stopped — all tasks complete',
      id: 'term-1',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'completed');
  });

  it('terminal detection with blocked: message sets status to blocked', async () => {
    const sessionId = await sm.startSession('/tmp/terminal-blocked', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Auto-mode stopped — blocked: needs user input',
      id: 'block-1',
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'blocked');
    assert.ok(session.pendingBlocker);
  });

  it('cost tracking: cumulative-max from cost_update events', async () => {
    const sessionId = await sm.startSession('/tmp/cost-track', { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    client.emitEvent({
      type: 'cost_update',
      cumulativeCost: 0.05,
      tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
    });

    client.emitEvent({
      type: 'cost_update',
      cumulativeCost: 0.12,
      tokens: { input: 2500, output: 800, cacheRead: 150, cacheWrite: 300 },
    });

    const session = sm.getSession(sessionId)!;
    assert.equal(session.cost.totalCost, 0.12);
    assert.equal(session.cost.tokens.input, 2500);
    assert.equal(session.cost.tokens.output, 800);
    assert.equal(session.cost.tokens.cacheRead, 200); // First was higher
    assert.equal(session.cost.tokens.cacheWrite, 300); // Second was higher
  });

  it('getResult returns HeadlessJsonResult-shaped object', async () => {
    const sessionId = await sm.startSession('/tmp/result-shape', { cliPath: '/usr/bin/gsd' });
    const result = sm.getResult(sessionId);

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.projectDir, resolve('/tmp/result-shape'));
    assert.equal(result.status, 'running');
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.cost);
    assert.ok(Array.isArray(result.recentEvents));
    assert.equal(result.pendingBlocker, null);
    assert.equal(result.error, null);
  });

  it('getResult errors for unknown session', () => {
    assert.throws(
      () => sm.getResult('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Session not found'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// CLI path resolution tests
// ---------------------------------------------------------------------------

describe('SessionManager.resolveCLIPath', () => {
  const originalGsdPath = process.env['GSD_CLI_PATH'];
  const originalPath = process.env['PATH'];

  afterEach(() => {
    if (originalGsdPath !== undefined) {
      process.env['GSD_CLI_PATH'] = originalGsdPath;
    } else {
      delete process.env['GSD_CLI_PATH'];
    }
    if (originalPath !== undefined) {
      process.env['PATH'] = originalPath;
    }
  });

  it('GSD_CLI_PATH env var takes precedence', () => {
    process.env['GSD_CLI_PATH'] = '/custom/path/to/gsd';
    const result = SessionManager.resolveCLIPath();
    assert.equal(result, resolve('/custom/path/to/gsd'));
  });

  it('throws when GSD_CLI_PATH not set and which fails', () => {
    delete process.env['GSD_CLI_PATH'];
    process.env['PATH'] = '/nonexistent';
    assert.throws(
      () => SessionManager.resolveCLIPath(),
      (err: Error) => {
        assert.ok(err.message.includes('Cannot find GSD CLI'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Tool registration tests (via createMcpServer)
// ---------------------------------------------------------------------------

describe('createMcpServer tool registration', () => {
  let sm: TestableSessionManager;

  beforeEach(() => {
    sm = createManager();
  });

  afterEach(async () => {
    for (const mgr of allManagers) {
      await mgr.cleanup();
    }
    allManagers = [];
  });

  it('creates server successfully with all required methods', async () => {
    const { server } = await createMcpServer(sm);
    assert.ok(server);
    assert.ok(server.server);
    assert.equal(typeof server.server.elicitInput, 'function');
    assert.ok(typeof server.connect === 'function');
    assert.ok(typeof server.close === 'function');
  });

  it('gsd_execute flow returns sessionId on success', async () => {
    const sessionId = await sm.startSession('/tmp/tool-exec', { cliPath: '/usr/bin/gsd' });
    assert.equal(typeof sessionId, 'string');
    assert.ok(sessionId.length > 0);
  });

  it('gsd_status flow returns correct shape', async () => {
    const sessionId = await sm.startSession('/tmp/tool-status', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;

    assert.equal(typeof session.status, 'string');
    assert.ok(Array.isArray(session.events));
    assert.ok(session.cost);
    assert.equal(typeof session.startTime, 'number');
  });

  it('gsd_resolve_blocker flow returns error when no blocker', async () => {
    const sessionId = await sm.startSession('/tmp/tool-resolve', { cliPath: '/usr/bin/gsd' });
    await assert.rejects(
      () => sm.resolveBlocker(sessionId, 'fix'),
      (err: Error) => {
        assert.ok(err.message.includes('No pending blocker'));
        return true;
      },
    );
  });

  it('gsd_result flow returns HeadlessJsonResult shape', async () => {
    const sessionId = await sm.startSession('/tmp/tool-result', { cliPath: '/usr/bin/gsd' });
    const result = sm.getResult(sessionId);

    assert.ok('sessionId' in result);
    assert.ok('projectDir' in result);
    assert.ok('status' in result);
    assert.ok('durationMs' in result);
    assert.ok('cost' in result);
    assert.ok('recentEvents' in result);
    assert.ok('pendingBlocker' in result);
    assert.ok('error' in result);
  });

  it('gsd_cancel flow marks session as cancelled', async () => {
    const sessionId = await sm.startSession('/tmp/tool-cancel', { cliPath: '/usr/bin/gsd' });
    await sm.cancelSession(sessionId);
    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'cancelled');
  });

  it('gsd_cancel can cancel an interactive session (no sessionId) via projectDir fallback', async () => {
    // Simulate an interactive session: registered by projectDir but with an empty sessionId
    // (e.g. started via `/gsd auto` in terminal or from a restarted MCP server that lost its session registry)
    const projectDir = resolve('/tmp/interactive-session');
    const mockClient = new MockRpcClient({ cwd: projectDir, args: [] });
    const interactiveSession: ManagedSession = {
      sessionId: '', // no sessionId — interactive/restarted scenario
      projectDir,
      status: 'running',
      client: mockClient as any,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };
    sm._putSession(projectDir, interactiveSession);

    // cancelSession('') should fail — no session found by empty sessionId
    // cancelSessionByDir should succeed — finds session by projectDir
    await sm.cancelSessionByDir(projectDir);

    const session = sm.getSessionByDir(projectDir)!;
    assert.equal(session.status, 'cancelled');
    assert.ok(mockClient.aborted, 'client.abort() should have been called');
  });

  it('gsd_cancel via projectDir works even when sessionId lookup returns undefined', async () => {
    // Start a normal session to get its projectDir
    const sessionId = await sm.startSession('/tmp/cancel-by-dir', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;
    const { projectDir } = session;

    // cancelSessionByDir should find it by dir and cancel it
    await sm.cancelSessionByDir(projectDir);
    assert.equal(session.status, 'cancelled');
  });

  it('buildAskUserQuestionsElicitRequest adds None of the above note field for single-select questions', () => {
    const request = buildAskUserQuestionsElicitRequest([
      {
        id: 'depth_verification_M001',
        header: 'Depth Check',
        question: 'Did I capture the depth right?',
        options: [
          { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
          { label: 'Not quite', description: 'I need to clarify the depth further.' },
        ],
      },
      {
        id: 'focus_areas',
        header: 'Focus',
        question: 'Which areas matter most?',
        allowMultiple: true,
        options: [
          { label: 'Frontend', description: 'Prioritize the UI.' },
          { label: 'Backend', description: 'Prioritize server logic.' },
        ],
      },
    ]);

    assert.equal(request.mode, 'form');
    assert.deepEqual(request.requestedSchema.required, ['depth_verification_M001', 'focus_areas']);
    assert.ok(request.requestedSchema.properties['depth_verification_M001']);
    assert.ok(request.requestedSchema.properties['depth_verification_M001__note']);
    assert.ok(!request.requestedSchema.properties['focus_areas__note']);
  });

  it('formatAskUserQuestionsElicitResult preserves the existing answers JSON shape', () => {
    const result = formatAskUserQuestionsElicitResult(
      [
        {
          id: 'depth_verification_M001',
          header: 'Depth Check',
          question: 'Did I capture the depth right?',
          options: [
            { label: 'Yes, you got it (Recommended)', description: 'Continue with the current summary.' },
            { label: 'Not quite', description: 'I need to clarify the depth further.' },
          ],
        },
        {
          id: 'focus_areas',
          header: 'Focus',
          question: 'Which areas matter most?',
          allowMultiple: true,
          options: [
            { label: 'Frontend', description: 'Prioritize the UI.' },
            { label: 'Backend', description: 'Prioritize server logic.' },
          ],
        },
      ],
      {
        action: 'accept',
        content: {
          depth_verification_M001: 'None of the above',
          depth_verification_M001__note: 'Need more implementation detail.',
          focus_areas: ['Frontend', 'Backend'],
        },
      },
    );

    assert.equal(
      result,
      JSON.stringify({
        answers: {
          depth_verification_M001: {
            answers: ['None of the above', 'user_note: Need more implementation detail.'],
          },
          focus_areas: {
            answers: ['Frontend', 'Backend'],
          },
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// withElicitTimeout
// ---------------------------------------------------------------------------

describe('withElicitTimeout', () => {
  it('resolves with the promise value when it settles before the timeout', async () => {
    const result = await withElicitTimeout(Promise.resolve(42), 'test', 5000);
    assert.equal(result, 42);
  });

  it('rejects with a timeout error when the promise does not settle in time', async () => {
    const never = new Promise<never>(() => {});
    await assert.rejects(
      () => withElicitTimeout(never, 'ask_user_questions', 1),
      (err: Error) => {
        assert.ok(err.message.includes('ask_user_questions'));
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
  });

  it('clears the timer when the promise resolves (no dangling timer)', async () => {
    // Spy on clearTimeout directly. `unhandledRejection` is not a reliable
    // proxy: Node does not flag losing-promise rejections from a settled
    // Promise.race as unhandled, so the absence of a stray rejection does
    // not actually prove clearTimeout ran. Asserting the spy was invoked
    // tests the cleanup contract directly.
    const originalClearTimeout = globalThis.clearTimeout;
    let clearCalls = 0;
    let lastClearedId: unknown = undefined;
    globalThis.clearTimeout = ((id: Parameters<typeof originalClearTimeout>[0]) => {
      clearCalls++;
      lastClearedId = id;
      return originalClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const value = await withElicitTimeout(Promise.resolve('done'), 'test', 50_000);
      assert.equal(value, 'done');
      assert.ok(
        clearCalls >= 1,
        `clearTimeout should run on resolve path; calls=${clearCalls}`,
      );
      assert.ok(lastClearedId !== undefined, 'clearTimeout should be called with the timer id');
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
