/**
 * Tests for Orchestrator — LLM agent for #gsd-control channel.
 *
 * Uses a MockAnthropicClient that simulates messages.create() responses,
 * allowing tool execution and conversation flow testing without real API calls.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Orchestrator, type OrchestratorConfig, type OrchestratorDeps, type DiscordMessageLike } from './orchestrator.js';
import { Logger } from './logger.js';
import type { ManagedSession, ProjectInfo, SessionStatus, CostAccumulator } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `orch-test-${randomUUID().slice(0, 8)}-`));
}

const cleanupDirs: string[] = [];
const activeLoggers: Logger[] = [];

async function cleanupAll(): Promise<void> {
  // Close all loggers first so write streams flush before dirs are removed
  for (const logger of activeLoggers) {
    try { await logger.close(); } catch { /* ignore */ }
  }
  activeLoggers.length = 0;

  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Mock Anthropic Client
// ---------------------------------------------------------------------------

interface MockCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  tools: unknown[];
  messages: unknown[];
}

type CreateHandler = (params: MockCreateParams) => {
  stop_reason: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
};

class MockAnthropicClient {
  public createCallCount = 0;
  public lastCreateParams: MockCreateParams | null = null;
  private createHandler: CreateHandler;

  constructor(handler?: CreateHandler) {
    this.createHandler = handler ?? MockAnthropicClient.defaultHandler;
  }

  /** Default handler: returns a simple text response */
  static defaultHandler(): ReturnType<CreateHandler> {
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Mock LLM response' }],
    };
  }

  /** Handler that simulates a tool call then end_turn */
  static toolThenTextHandler(toolName: string, toolInput: unknown, finalText: string): CreateHandler {
    let callCount = 0;
    return () => {
      callCount++;
      if (callCount === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: `toolu_${randomUUID().slice(0, 8)}`,
              name: toolName,
              input: toolInput,
            },
          ],
        };
      }
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: finalText }],
      };
    };
  }

  /** Handler that throws an error */
  static errorHandler(message: string): CreateHandler {
    return () => {
      throw new Error(message);
    };
  }

  messages = {
    create: async (params: MockCreateParams) => {
      this.createCallCount++;
      this.lastCreateParams = params;
      return this.createHandler(params);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock SessionManager
// ---------------------------------------------------------------------------

function makeMockSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    sessionId: overrides.sessionId ?? 'sess-123',
    projectDir: overrides.projectDir ?? '/home/user/project',
    projectName: overrides.projectName ?? 'my-project',
    status: overrides.status ?? ('running' as SessionStatus),
    client: {} as ManagedSession['client'],
    events: [],
    pendingBlocker: null,
    cost: overrides.cost ?? { totalCost: 0.1234, tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } },
    startTime: overrides.startTime ?? Date.now() - 300_000, // 5 min ago
    ...overrides,
  };
}

class MockSessionManager {
  public sessions: ManagedSession[] = [];
  public startSessionCalls: Array<{ projectDir: string; command?: string }> = [];
  public cancelSessionCalls: string[] = [];
  public getResultCalls: string[] = [];

  async startSession(opts: { projectDir: string; command?: string }): Promise<string> {
    this.startSessionCalls.push(opts);
    return 'sess-new-123';
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.find((s) => s.sessionId === sessionId);
  }

  getAllSessions(): ManagedSession[] {
    return this.sessions;
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.cancelSessionCalls.push(sessionId);
  }

  getResult(sessionId: string): Record<string, unknown> {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      projectName: session.projectName,
      status: session.status,
      durationMs: 300_000,
      cost: session.cost,
      recentEvents: [],
      pendingBlocker: null,
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock ChannelManager (unused by orchestrator directly, but required by deps)
// ---------------------------------------------------------------------------

class MockChannelManager {}

// ---------------------------------------------------------------------------
// Mock Discord Message
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<{
  authorId: string;
  bot: boolean;
  channelId: string;
  content: string;
}>): DiscordMessageLike & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    author: {
      id: overrides.authorId ?? 'owner-123',
      bot: overrides.bot ?? false,
    },
    channelId: overrides.channelId ?? 'control-channel-1',
    content: overrides.content ?? 'hello',
    channel: {
      send: async (content: string) => {
        sentMessages.push(content);
      },
      sendTyping: async () => {},
    },
    sentMessages,
  };
}

// ---------------------------------------------------------------------------
// Test Setup Factory
// ---------------------------------------------------------------------------

function makeOrchestrator(opts?: {
  client?: MockAnthropicClient;
  sessions?: ManagedSession[];
  projects?: ProjectInfo[];
}) {
  const dir = tmpDir();
  cleanupDirs.push(dir);
  const logPath = join(dir, 'test.log');
  const logger = new Logger({ filePath: logPath, level: 'debug' });
  activeLoggers.push(logger);

  const sessionManager = new MockSessionManager();
  if (opts?.sessions) sessionManager.sessions = opts.sessions;

  const projects: ProjectInfo[] = opts?.projects ?? [
    { name: 'alpha', path: '/home/user/alpha', markers: ['git', 'node', 'gsd'], lastModified: Date.now() },
    { name: 'bravo', path: '/home/user/bravo', markers: ['git', 'rust'], lastModified: Date.now() },
  ];

  const config: OrchestratorConfig = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    control_channel_id: 'control-channel-1',
  };

  const deps: OrchestratorDeps = {
    sessionManager: sessionManager as unknown as OrchestratorDeps['sessionManager'],
    channelManager: new MockChannelManager() as unknown as OrchestratorDeps['channelManager'],
    scanProjects: async () => projects,
    config,
    logger,
    ownerId: 'owner-123',
  };

  const mockClient = opts?.client ?? new MockAnthropicClient();
  const orchestrator = new Orchestrator(deps, mockClient as unknown as import('@anthropic-ai/sdk').default);

  return { orchestrator, mockClient, sessionManager, logger, logPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  // Clean up after each test so logger streams are flushed before dirs removed
  afterEach(async () => {
    await cleanupAll();
  });

  // ---- Tool definitions ----

  describe('tool definitions', () => {
    it('passes 5 tools to the Anthropic API', async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ content: 'what can you do?' });
      await orchestrator.handleMessage(msg);

      assert.ok(mockClient.lastCreateParams);
      const tools = mockClient.lastCreateParams.tools as Array<{ name: string }>;
      assert.equal(tools.length, 5);

      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'get_session_detail',
        'get_status',
        'list_projects',
        'start_session',
        'stop_session',
      ]);
    });
  });

  // ---- list_projects tool ----

  describe('list_projects tool', () => {
    it('returns project list from scanProjects', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler('list_projects', {}, 'Here are your projects'),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: 'list my projects' });
      await orchestrator.handleMessage(msg);

      assert.equal(msg.sentMessages.length, 1);
      assert.equal(msg.sentMessages[0], 'Here are your projects');
      // The tool was called (2 create calls: tool_use + end_turn)
      assert.equal(mockClient.createCallCount, 2);
    });
  });

  // ---- start_session tool ----

  describe('start_session tool', () => {
    it('calls sessionManager.startSession and returns confirmation', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          'start_session',
          { projectPath: '/home/user/alpha' },
          'Started session for alpha',
        ),
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: 'start alpha' });
      await orchestrator.handleMessage(msg);

      assert.equal(sessionManager.startSessionCalls.length, 1);
      assert.equal(sessionManager.startSessionCalls[0]!.projectDir, '/home/user/alpha');
      assert.equal(msg.sentMessages[0], 'Started session for alpha');
    });
  });

  // ---- get_status tool ----

  describe('get_status tool', () => {
    it('returns formatted session status', async () => {
      const session = makeMockSession({ projectName: 'alpha', status: 'running' as SessionStatus });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler('get_status', {}, 'Status: alpha is running'),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: 'status' });
      await orchestrator.handleMessage(msg);

      assert.equal(msg.sentMessages[0], 'Status: alpha is running');
    });

    it('handles empty session list', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler('get_status', {}, 'No sessions running'),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, sessions: [] });
      const msg = makeMessage({ content: 'status' });
      await orchestrator.handleMessage(msg);

      assert.equal(msg.sentMessages[0], 'No sessions running');
    });
  });

  // ---- stop_session tool ----

  describe('stop_session tool', () => {
    it('stops session matched by sessionId', async () => {
      const session = makeMockSession({ sessionId: 'sess-abc', projectName: 'alpha' });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          'stop_session',
          { identifier: 'sess-abc' },
          'Stopped alpha',
        ),
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: 'stop sess-abc' });
      await orchestrator.handleMessage(msg);

      assert.equal(sessionManager.cancelSessionCalls.length, 1);
      assert.equal(sessionManager.cancelSessionCalls[0], 'sess-abc');
    });

    it('fuzzy matches by project name', async () => {
      const session = makeMockSession({ sessionId: 'sess-xyz', projectName: 'my-big-project' });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          'stop_session',
          { identifier: 'big-project' },
          'Stopped my-big-project',
        ),
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: 'stop big project' });
      await orchestrator.handleMessage(msg);

      assert.equal(sessionManager.cancelSessionCalls.length, 1);
      assert.equal(sessionManager.cancelSessionCalls[0], 'sess-xyz');
    });

    it('returns not-found for unmatched identifier', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          'stop_session',
          { identifier: 'nonexistent' },
          'No session found',
        ),
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient, sessions: [] });
      const msg = makeMessage({ content: 'stop nonexistent' });
      await orchestrator.handleMessage(msg);

      assert.equal(sessionManager.cancelSessionCalls.length, 0);
    });
  });

  // ---- get_session_detail tool ----

  describe('get_session_detail tool', () => {
    it('returns formatted session detail', async () => {
      const session = makeMockSession({ sessionId: 'sess-detail' });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          'get_session_detail',
          { sessionId: 'sess-detail' },
          'Session details for my-project',
        ),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: 'detail sess-detail' });
      await orchestrator.handleMessage(msg);

      assert.equal(msg.sentMessages[0], 'Session details for my-project');
    });
  });

  // ---- Message routing / auth guards ----

  describe('handleMessage routing', () => {
    it('ignores bot messages', async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ bot: true, content: 'hello from bot' });
      await orchestrator.handleMessage(msg);

      assert.equal(mockClient.createCallCount, 0);
      assert.equal(msg.sentMessages.length, 0);
    });

    it('ignores non-owner messages', async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ authorId: 'stranger-456', content: 'hack the planet' });
      await orchestrator.handleMessage(msg);

      assert.equal(mockClient.createCallCount, 0);
      assert.equal(msg.sentMessages.length, 0);
    });

    it('ignores messages from non-control channels', async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ channelId: 'random-channel', content: 'hello' });
      await orchestrator.handleMessage(msg);

      assert.equal(mockClient.createCallCount, 0);
      assert.equal(msg.sentMessages.length, 0);
    });

    it('ignores empty message content', async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ content: '   ' });
      await orchestrator.handleMessage(msg);

      assert.equal(mockClient.createCallCount, 0);
    });

    it('routes valid message through LLM and sends response', async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ content: 'hello orchestrator' });
      await orchestrator.handleMessage(msg);

      assert.equal(mockClient.createCallCount, 1);
      assert.equal(msg.sentMessages.length, 1);
      assert.equal(msg.sentMessages[0], 'Mock LLM response');
    });
  });

  // ---- Conversation history ----

  describe('conversation history', () => {
    it('accumulates user and assistant entries', async () => {
      const { orchestrator } = makeOrchestrator();

      await orchestrator.handleMessage(makeMessage({ content: 'first' }));
      await orchestrator.handleMessage(makeMessage({ content: 'second' }));

      const history = orchestrator.getHistory();
      assert.equal(history.length, 4); // 2 user + 2 assistant
      assert.equal(history[0]!.role, 'user');
      assert.equal(history[1]!.role, 'assistant');
      assert.equal(history[2]!.role, 'user');
      assert.equal(history[3]!.role, 'assistant');
    });

    it('trims to MAX_HISTORY (30) by removing oldest pairs', async () => {
      const { orchestrator } = makeOrchestrator();

      // Send 17 messages → 34 history entries (17 user + 17 assistant)
      // After trimming: should be ≤30
      for (let i = 0; i < 17; i++) {
        await orchestrator.handleMessage(makeMessage({ content: `msg-${i}` }));
      }

      const history = orchestrator.getHistory();
      assert.ok(history.length <= 30, `History length ${history.length} exceeds 30`);
      // Should have trimmed from the front — oldest entries gone
      // 34 entries → trim 2 at a time until ≤30 → 30 entries (trimmed 4)
      assert.equal(history.length, 30);
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('sends error message to Discord when LLM API throws', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.errorHandler('API rate limit exceeded'),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: 'hello' });
      await orchestrator.handleMessage(msg);

      assert.equal(msg.sentMessages.length, 1);
      assert.ok(msg.sentMessages[0]!.includes('Something went wrong'));
    });

    it('appends error placeholder to history on LLM failure', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.errorHandler('Network error'),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient });
      await orchestrator.handleMessage(makeMessage({ content: 'fail' }));

      const history = orchestrator.getHistory();
      assert.equal(history.length, 2); // user + error assistant
      assert.equal(history[1]!.role, 'assistant');
      assert.equal(history[1]!.content, '[error — see logs]');
    });
  });

  // ---- stop() ----

  describe('stop()', () => {
    it('clears conversation history and nulls client', async () => {
      const { orchestrator } = makeOrchestrator();

      await orchestrator.handleMessage(makeMessage({ content: 'hello' }));
      assert.ok(orchestrator.getHistory().length > 0);

      orchestrator.stop();
      assert.equal(orchestrator.getHistory().length, 0);
    });
  });

  // ---- Tool execution direct tests ----

  describe('tool execution (via agent loop)', () => {
    it('list_projects returns empty message when no projects', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler('list_projects', {}, 'No projects'),
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, projects: [] });
      const msg = makeMessage({ content: 'list' });
      await orchestrator.handleMessage(msg);

      // The second create call receives the tool result
      assert.equal(mockClient.createCallCount, 2);
    });

    it('start_session with optional command passes through', async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          'start_session',
          { projectPath: '/p', command: '/gsd quick fix tests' },
          'Started',
        ),
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: 'start with custom command' });
      await orchestrator.handleMessage(msg);

      assert.equal(sessionManager.startSessionCalls.length, 1);
      assert.equal(sessionManager.startSessionCalls[0]!.command, '/gsd quick fix tests');
    });
  });

});
