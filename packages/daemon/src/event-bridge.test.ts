/**
 * event-bridge.test.ts — Tests for EventBridge orchestrator.
 *
 * Uses mock SessionManager (EventEmitter), mock ChannelManager,
 * mock Discord Client, and mock Logger to test event wiring,
 * blocker handling, conversation relay, and cleanup.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EventBridge } from './event-bridge.js';
import type { EventBridgeOptions, BridgeClient } from './event-bridge.js';
import type { PendingBlocker, ManagedSession, DaemonConfig, SessionStatus } from './types.js';
import type { SdkAgentEvent, RpcClient, RpcExtensionUIRequest } from '@gsd-build/rpc-client';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    debug: mock.fn(() => {}),
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
    error: mock.fn(() => {}),
  };
}

function createMockChannelManager() {
  const sentMessages: unknown[] = [];
  const mockChannel = {
    id: 'ch-123',
    send: mock.fn(async (_payload: unknown) => {
      sentMessages.push(_payload);
      return { id: 'msg-1' };
    }),
    createMessageComponentCollector: mock.fn((_opts?: unknown) => {
      const collector = new EventEmitter() as EventEmitter & { stop: (reason?: string) => void };
      collector.stop = (reason?: string) => collector.emit('end', [], reason ?? 'manual');
      return collector;
    }),
  };
  return {
    createProjectChannel: mock.fn(async (_dir: string) => mockChannel),
    _channel: mockChannel,
    _sentMessages: sentMessages,
  };
}

function createMockClient(): BridgeClient & EventEmitter {
  const emitter = new EventEmitter();
  const dmSendFn = mock.fn(async () => ({}));
  const fetchFn = mock.fn(async (_id: string) => ({ send: dmSendFn }));
  (emitter as unknown as Record<string, unknown>).users = { fetch: fetchFn };
  return Object.assign(emitter, {
    users: { fetch: fetchFn },
    _dmSend: dmSendFn,
  }) as unknown as BridgeClient & EventEmitter;
}

function createMockSessionManager() {
  const sm = new EventEmitter() as EventEmitter & {
    getSession: ReturnType<typeof mock.fn>;
    resolveBlocker: ReturnType<typeof mock.fn>;
  };
  sm.getSession = mock.fn((_id: string) => undefined as ManagedSession | undefined);
  sm.resolveBlocker = mock.fn(async (_sid: string, _resp: string) => {});
  return sm;
}

function createMockSession(overrides?: Partial<ManagedSession>): ManagedSession {
  return {
    sessionId: 'sess-1',
    projectDir: '/test/project',
    projectName: 'project',
    status: 'running' as SessionStatus,
    client: {
      steer: mock.fn(async (_msg: string) => {}),
      prompt: mock.fn(async () => ({})),
    } as unknown as RpcClient,
    events: [],
    pendingBlocker: null,
    cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    startTime: Date.now(),
    ...overrides,
  };
}

const DEFAULT_CONFIG: DaemonConfig = {
  discord: {
    token: 'test-token',
    guild_id: 'guild-1',
    owner_id: 'owner-1',
    dm_on_blocker: false,
  },
  projects: { scan_roots: [] },
  log: { file: '/tmp/test.log', level: 'debug', max_size_mb: 10 },
};

function buildBridge(overrides?: Partial<EventBridgeOptions>) {
  const sessionManager = createMockSessionManager();
  const channelManager = createMockChannelManager();
  const client = createMockClient();
  const logger = createMockLogger();

  const opts: EventBridgeOptions = {
    sessionManager: sessionManager as unknown as EventBridgeOptions['sessionManager'],
    channelManager: channelManager as unknown as EventBridgeOptions['channelManager'],
    client,
    config: DEFAULT_CONFIG,
    logger: logger as unknown as EventBridgeOptions['logger'],
    ownerId: 'owner-1',
    ...overrides,
  };

  const bridge = new EventBridge(opts);
  return { bridge, sessionManager, channelManager, client, logger };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tick = () => new Promise<void>((r) => setTimeout(r, 30));

function mockFn(obj: unknown): { mock: { callCount(): number; calls: Array<{ arguments: unknown[]; result?: unknown }> } } {
  return obj as { mock: { callCount(): number; calls: Array<{ arguments: unknown[]; result?: unknown }> } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventBridge', () => {
  describe('lifecycle', () => {
    it('start() subscribes to session manager events and messageCreate', () => {
      const { bridge, sessionManager, client } = buildBridge();
      bridge.start();
      assert.ok(sessionManager.listenerCount('session:started') > 0);
      assert.ok(sessionManager.listenerCount('session:event') > 0);
      assert.ok(sessionManager.listenerCount('session:blocked') > 0);
      assert.ok(sessionManager.listenerCount('session:completed') > 0);
      assert.ok(sessionManager.listenerCount('session:error') > 0);
      assert.ok(client.listenerCount('messageCreate') > 0);
    });

    it('stop() unsubscribes from all events and clears mappings', async () => {
      const { bridge, sessionManager, client } = buildBridge();
      bridge.start();
      await bridge.stop();
      assert.equal(sessionManager.listenerCount('session:started'), 0);
      assert.equal(sessionManager.listenerCount('session:event'), 0);
      assert.equal(sessionManager.listenerCount('session:blocked'), 0);
      assert.equal(sessionManager.listenerCount('session:completed'), 0);
      assert.equal(sessionManager.listenerCount('session:error'), 0);
      assert.equal(client.listenerCount('messageCreate'), 0);
    });

    it('start() is idempotent', () => {
      const { bridge, sessionManager } = buildBridge();
      bridge.start();
      bridge.start();
      assert.equal(sessionManager.listenerCount('session:started'), 1);
    });

    it('getVerbosityManager() returns a VerbosityManager', () => {
      const { bridge } = buildBridge();
      const vm = bridge.getVerbosityManager();
      assert.ok(vm);
      assert.equal(typeof vm.shouldShow, 'function');
    });
  });

  describe('session:started → channel creation + welcome embed', () => {
    it('creates channel and batcher', async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();
      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();
      assert.equal(mockFn(channelManager.createProjectChannel).mock.callCount(), 1);
    });

    it('logs error and skips when channel creation fails', async () => {
      const failingCm = {
        createProjectChannel: mock.fn(async () => { throw new Error('API error'); }),
      };
      const { bridge, sessionManager, logger } = buildBridge({
        channelManager: failingCm as unknown as EventBridgeOptions['channelManager'],
      });
      bridge.start();
      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();
      assert.ok(mockFn(logger.error).mock.callCount() > 0);
    });
  });

  describe('session:event → format + verbosity filter + enqueue', () => {
    it('formats event and enqueues to batcher (no errors)', async () => {
      const { bridge, sessionManager, logger } = buildBridge();
      bridge.start();
      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      sessionManager.emit('session:event', {
        sessionId: 'sess-1', projectDir: '/test/project',
        event: { type: 'tool_execution_start', name: 'read' } as SdkAgentEvent,
      });
      await tick();
      // No errors
      assert.equal(mockFn(logger.error).mock.callCount(), 0);
    });

    it('filters events based on verbosity', async () => {
      const { bridge, sessionManager, channelManager, logger } = buildBridge();
      bridge.start();
      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      // Set quiet mode
      bridge.getVerbosityManager().setLevel('ch-123', 'quiet');

      // cost_update filtered in quiet
      sessionManager.emit('session:event', {
        sessionId: 'sess-1', projectDir: '/test/project',
        event: { type: 'cost_update', cumulativeCost: 1.5 } as SdkAgentEvent,
      });
      await tick();
      // tool_execution_start filtered in quiet
      sessionManager.emit('session:event', {
        sessionId: 'sess-1', projectDir: '/test/project',
        event: { type: 'tool_execution_start', name: 'read' } as SdkAgentEvent,
      });
      await tick();
      assert.equal(mockFn(logger.error).mock.callCount(), 0);
    });
  });

  describe('session:blocked → blocker embed + buttons + optional DM', () => {
    it('sends blocker embed and creates collector for confirm', async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();
      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const blocker: PendingBlocker = {
        id: 'blocker-1', method: 'confirm', message: 'Continue?',
        event: { id: 'blocker-1', method: 'confirm', message: 'Continue?' } as RpcExtensionUIRequest,
      };
      sessionManager.emit('session:blocked', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', blocker,
      });
      await tick();
      assert.ok(mockFn(channelManager._channel.createMessageComponentCollector).mock.callCount() > 0);
    });

    it('sends DM when dm_on_blocker is configured', async () => {
      const config: DaemonConfig = {
        ...DEFAULT_CONFIG,
        discord: { ...DEFAULT_CONFIG.discord!, dm_on_blocker: true },
      };
      const client = createMockClient();
      const { bridge, sessionManager } = buildBridge({ config, client });
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const blocker: PendingBlocker = {
        id: 'blocker-1', method: 'input', message: 'Enter API key',
        event: { id: 'blocker-1', method: 'input' } as RpcExtensionUIRequest,
      };
      sessionManager.emit('session:blocked', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', blocker,
      });
      await tick();

      const usersFetch = (client as unknown as Record<string, { fetch: unknown }>).users.fetch;
      assert.equal(mockFn(usersFetch).mock.callCount(), 1);
    });

    it('does not send DM when dm_on_blocker is false', async () => {
      const client = createMockClient();
      const { bridge, sessionManager } = buildBridge({ client });
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const blocker: PendingBlocker = {
        id: 'blocker-1', method: 'input', message: 'Enter value',
        event: { id: 'blocker-1', method: 'input' } as RpcExtensionUIRequest,
      };
      sessionManager.emit('session:blocked', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', blocker,
      });
      await tick();

      const usersFetch = (client as unknown as Record<string, { fetch: unknown }>).users.fetch;
      assert.equal(mockFn(usersFetch).mock.callCount(), 0);
    });
  });

  describe('button collector → resolveBlocker', () => {
    it('resolves blocker on button click from authorized user', async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const blocker: PendingBlocker = {
        id: 'blocker-1', method: 'confirm', message: 'Confirm?',
        event: { id: 'blocker-1', method: 'confirm' } as RpcExtensionUIRequest,
      };
      sessionManager.emit('session:blocked', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', blocker,
      });
      await tick();

      const collectorCalls = mockFn(channelManager._channel.createMessageComponentCollector).mock.calls;
      assert.ok(collectorCalls.length > 0);
      const collector = collectorCalls[0]!.result as EventEmitter;

      const mockInteraction = {
        customId: 'blocker:blocker-1:confirm:true',
        user: { id: 'owner-1' },
        update: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      };
      collector.emit('collect', mockInteraction);
      await tick();

      assert.equal(mockFn(sessionManager.resolveBlocker).mock.callCount(), 1);
      const args = mockFn(sessionManager.resolveBlocker).mock.calls[0]!.arguments;
      assert.equal(args[0], 'sess-1');
      assert.equal(args[1], 'true');
    });

    it('rejects button click from unauthorized user', async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const blocker: PendingBlocker = {
        id: 'blocker-1', method: 'confirm', message: 'Confirm?',
        event: { id: 'blocker-1', method: 'confirm' } as RpcExtensionUIRequest,
      };
      sessionManager.emit('session:blocked', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', blocker,
      });
      await tick();

      const collectorCalls = mockFn(channelManager._channel.createMessageComponentCollector).mock.calls;
      const collector = collectorCalls[0]!.result as EventEmitter;

      const mockInteraction = {
        customId: 'blocker:blocker-1:confirm:true',
        user: { id: 'stranger-99' },
        update: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      };
      collector.emit('collect', mockInteraction);
      await tick();

      assert.equal(mockFn(sessionManager.resolveBlocker).mock.callCount(), 0);
      assert.equal(mockFn(mockInteraction.reply).mock.callCount(), 1);
    });

    it('posts error when resolveBlocker throws', async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      sessionManager.resolveBlocker = mock.fn(async () => { throw new Error('No pending blocker'); });
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const blocker: PendingBlocker = {
        id: 'blocker-1', method: 'confirm', message: 'Confirm?',
        event: { id: 'blocker-1', method: 'confirm' } as RpcExtensionUIRequest,
      };
      sessionManager.emit('session:blocked', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', blocker,
      });
      await tick();

      const collectorCalls = mockFn(channelManager._channel.createMessageComponentCollector).mock.calls;
      const collector = collectorCalls[0]!.result as EventEmitter;

      const mockInteraction = {
        customId: 'blocker:blocker-1:confirm:true',
        user: { id: 'owner-1' },
        update: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      };
      collector.emit('collect', mockInteraction);
      await tick();

      assert.equal(mockFn(mockInteraction.reply).mock.callCount(), 1);
      const replyArg = mockFn(mockInteraction.reply).mock.calls[0]!.arguments[0] as Record<string, unknown>;
      assert.ok(String(replyArg.content).includes('Failed to resolve'));
    });
  });

  describe('messageCreate relay', () => {
    it('relays message to session steer when no pending blocker', async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const msg = {
        author: { id: 'owner-1', bot: false },
        channelId: 'ch-123',
        content: 'check the test results',
        react: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      };
      client.emit('messageCreate', msg);
      await tick();

      assert.equal(mockFn(session.client.steer).mock.callCount(), 1);
      assert.equal(mockFn(session.client.steer).mock.calls[0]!.arguments[0], 'check the test results');
    });

    it('resolves blocker via relay for input method', async () => {
      const blocker: PendingBlocker = {
        id: 'blocker-2', method: 'input', message: 'Enter value',
        event: { id: 'blocker-2', method: 'input' } as RpcExtensionUIRequest,
      };
      const session = createMockSession({ pendingBlocker: blocker, status: 'blocked' });
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const msg = {
        author: { id: 'owner-1', bot: false },
        channelId: 'ch-123',
        content: 'my-api-key-value',
        react: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      };
      client.emit('messageCreate', msg);
      await tick();

      assert.equal(mockFn(sessionManager.resolveBlocker).mock.callCount(), 1);
      assert.equal(mockFn(sessionManager.resolveBlocker).mock.calls[0]!.arguments[1], 'my-api-key-value');
    });

    it('ignores bot messages', async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      client.emit('messageCreate', {
        author: { id: 'bot-1', bot: true },
        channelId: 'ch-123',
        content: 'automated',
        react: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      });
      await tick();

      assert.equal(mockFn(session.client.steer).mock.callCount(), 0);
    });

    it('ignores messages in non-project channels', async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();

      client.emit('messageCreate', {
        author: { id: 'owner-1', bot: false },
        channelId: 'random-ch-999',
        content: 'hello',
        react: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      });
      await tick();

      assert.equal(mockFn(session.client.steer).mock.callCount(), 0);
    });

    it('ignores messages from unauthorized users', async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      client.emit('messageCreate', {
        author: { id: 'stranger-99', bot: false },
        channelId: 'ch-123',
        content: 'hack the planet',
        react: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      });
      await tick();

      assert.equal(mockFn(session.client.steer).mock.callCount(), 0);
    });

    it('posts error when steer fails', async () => {
      const session = createMockSession();
      (session.client as unknown as Record<string, unknown>).steer = mock.fn(async () => {
        throw new Error('session dead');
      });
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      const msg = {
        author: { id: 'owner-1', bot: false },
        channelId: 'ch-123',
        content: 'try this',
        react: mock.fn(async () => {}),
        reply: mock.fn(async () => {}),
      };
      client.emit('messageCreate', msg);
      await tick();

      assert.equal(mockFn(msg.reply).mock.callCount(), 1);
    });
  });

  describe('session:completed → cleanup', () => {
    it('posts completion embed and cleans up', async () => {
      const { bridge, sessionManager, logger } = buildBridge();
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      sessionManager.emit('session:completed', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      // After cleanup, events for this session are silently ignored
      sessionManager.emit('session:event', {
        sessionId: 'sess-1', projectDir: '/test/project',
        event: { type: 'tool_execution_start', name: 'read' } as SdkAgentEvent,
      });
      await tick();
      assert.equal(mockFn(logger.error).mock.callCount(), 0);
    });
  });

  describe('session:error → cleanup', () => {
    it('posts error embed and cleans up', async () => {
      const { bridge, sessionManager, logger } = buildBridge();
      bridge.start();

      sessionManager.emit('session:started', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project',
      });
      await tick();

      sessionManager.emit('session:error', {
        sessionId: 'sess-1', projectDir: '/test/project', projectName: 'my-project', error: 'Process crashed',
      });
      await tick();

      const infoCalls = mockFn(logger.info).mock.calls;
      assert.ok(
        infoCalls.some((c) => String(c.arguments[0]).includes('session error')),
      );
    });
  });
});
