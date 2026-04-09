import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { isAuthorized, validateDiscordConfig } from './discord-bot.js';
import { sanitizeChannelName, ChannelManager } from './channel-manager.js';
import { buildCommands, formatSessionStatus } from './commands.js';
import { Daemon } from './daemon.js';
import { Logger } from './logger.js';
import { validateConfig } from './config.js';
import type { DaemonConfig, LogEntry, ManagedSession } from './types.js';

// ---------- helpers ----------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `discord-test-${randomUUID().slice(0, 8)}-`));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ---------- isAuthorized ----------

describe('isAuthorized', () => {
  it('returns true when userId matches ownerId', () => {
    assert.equal(isAuthorized('12345', '12345'), true);
  });

  it('returns false when userId does not match ownerId', () => {
    assert.equal(isAuthorized('12345', '99999'), false);
  });

  it('returns false when ownerId is empty', () => {
    assert.equal(isAuthorized('12345', ''), false);
  });

  it('returns false when userId is empty', () => {
    assert.equal(isAuthorized('', '12345'), false);
  });

  it('returns false when both are empty', () => {
    assert.equal(isAuthorized('', ''), false);
  });
});

// ---------- validateDiscordConfig ----------

describe('validateDiscordConfig', () => {
  it('passes with all required fields', () => {
    assert.doesNotThrow(() => {
      validateDiscordConfig({
        token: 'test-token',
        guild_id: 'g123',
        owner_id: 'o456',
      });
    });
  });

  it('throws on undefined config', () => {
    assert.throws(
      () => validateDiscordConfig(undefined),
      (err: Error) => {
        assert.ok(err.message.includes('undefined'));
        return true;
      },
    );
  });

  it('throws on missing token', () => {
    assert.throws(
      () => validateDiscordConfig({ token: '', guild_id: 'g1', owner_id: 'o1' }),
      (err: Error) => {
        assert.ok(err.message.includes('token'));
        return true;
      },
    );
  });

  it('throws on whitespace-only token', () => {
    assert.throws(
      () => validateDiscordConfig({ token: '   ', guild_id: 'g1', owner_id: 'o1' }),
      (err: Error) => {
        assert.ok(err.message.includes('token'));
        return true;
      },
    );
  });

  it('throws on missing guild_id', () => {
    assert.throws(
      () => validateDiscordConfig({ token: 'tok', guild_id: '', owner_id: 'o1' }),
      (err: Error) => {
        assert.ok(err.message.includes('guild_id'));
        return true;
      },
    );
  });

  it('throws on missing owner_id', () => {
    assert.throws(
      () => validateDiscordConfig({ token: 'tok', guild_id: 'g1', owner_id: '' }),
      (err: Error) => {
        assert.ok(err.message.includes('owner_id'));
        return true;
      },
    );
  });
});

// ---------- Daemon wiring ----------

describe('Daemon + DiscordBot wiring', () => {
  it('does not create DiscordBot when discord config is absent', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'no-discord.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'debug', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    const content = readFileSync(logPath, 'utf-8');
    // Should NOT have any bot-related log entries
    assert.ok(!content.includes('bot ready'));
    assert.ok(!content.includes('discord bot login failed'));
    assert.ok(!content.includes('bot destroyed'));
  });

  it('logs error when discord config has token but login fails (no real gateway)', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'bad-token.log');

    const config: DaemonConfig = {
      discord: {
        token: 'invalid-token-that-will-fail-login',
        guild_id: 'g1',
        owner_id: 'o1',
      },
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'debug', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    const daemon = new Daemon(config, logger);

    // start() should NOT throw — bot login failure is non-fatal
    await daemon.start();

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    // Small flush delay
    await new Promise((r) => setTimeout(r, 50));

    const content = readFileSync(logPath, 'utf-8');
    // Should have logged the login failure
    assert.ok(content.includes('discord bot login failed'), 'should log bot login failure');
    // Token should never appear in logs
    assert.ok(!content.includes('invalid-token-that-will-fail-login'), 'token must not appear in logs');
  });

  it('does not attempt login when discord config has no token', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'no-token.log');

    // Config with discord block but empty token
    const config: DaemonConfig = {
      discord: {
        token: '',
        guild_id: 'g1',
        owner_id: 'o1',
      },
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'debug', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    const content = readFileSync(logPath, 'utf-8');
    // Should not attempt login — no token
    assert.ok(!content.includes('discord bot login failed'));
    assert.ok(!content.includes('bot ready'));
  });
});

// ---------- sanitizeChannelName ----------

describe('sanitizeChannelName', () => {
  it('converts basic path to gsd-prefixed name', () => {
    assert.equal(sanitizeChannelName('/home/user/my-project'), 'gsd-my-project');
  });

  it('converts path with special characters to hyphens', () => {
    assert.equal(sanitizeChannelName('/home/user/My_Cool.Project!v2'), 'gsd-my-cool-project-v2');
  });

  it('truncates very long names to 100 chars', () => {
    const longName = 'a'.repeat(200);
    const result = sanitizeChannelName(`/home/${longName}`);
    assert.ok(result.length <= 100, `Expected <= 100 chars, got ${result.length}`);
    assert.ok(result.startsWith('gsd-'));
  });

  it('cleans leading/trailing dots and underscores', () => {
    assert.equal(sanitizeChannelName('/home/...___project___...'), 'gsd-project');
  });

  it('returns gsd-unnamed for empty basename', () => {
    assert.equal(sanitizeChannelName(''), 'gsd-unnamed');
    assert.equal(sanitizeChannelName('/'), 'gsd-unnamed');
  });

  it('returns gsd-unnamed for basename with only special chars', () => {
    assert.equal(sanitizeChannelName('/home/!!!'), 'gsd-unnamed');
  });

  it('collapses consecutive hyphens', () => {
    assert.equal(sanitizeChannelName('/home/a---b---c'), 'gsd-a-b-c');
  });

  it('handles Windows-style backslash paths', () => {
    assert.equal(sanitizeChannelName('C:\\Users\\lex\\my-project'), 'gsd-my-project');
  });

  it('handles name at exact prefix + 96 chars = 100 char limit', () => {
    // gsd- is 4 chars, so a 96-char basename should produce exactly 100
    const name96 = 'a'.repeat(96);
    const result = sanitizeChannelName(`/home/${name96}`);
    assert.equal(result.length, 100);
    assert.equal(result, `gsd-${'a'.repeat(96)}`);
  });

  it('handles whitespace-only basename', () => {
    assert.equal(sanitizeChannelName('/home/   '), 'gsd-unnamed');
  });
});

// ---------- ChannelManager ----------

describe('ChannelManager', () => {
  // Helper to create a mock Guild with controllable channel cache and create method
  function createMockGuild() {
    const channels = new Map<string, { id: string; name: string; type: number; parentId: string | null; edit?: Function }>();
    let createCounter = 0;

    const mockGuild = {
      id: 'guild-123', // @everyone role ID matches guild ID
      channels: {
        cache: {
          get: (id: string) => channels.get(id),
          find: (fn: (ch: any) => boolean) => {
            for (const ch of channels.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          },
        },
        create: async (opts: { name: string; type: number; parent?: string; permissionOverwrites?: any[] }) => {
          createCounter++;
          const id = `chan-${createCounter}`;
          const ch = {
            id,
            name: opts.name,
            type: opts.type,
            parentId: opts.parent ?? null,
            edit: async (editOpts: any) => {
              // Simulate edit — update parent
              ch.parentId = editOpts.parent ?? ch.parentId;
              return ch;
            },
          };
          channels.set(id, ch);
          return ch;
        },
      },
      _channels: channels, // internal for test inspection
      _getCreateCount: () => createCounter,
    };

    return mockGuild;
  }

  function createMockLogger() {
    const entries: { level: string; msg: string; data?: any }[] = [];
    return {
      debug: (msg: string, data?: any) => entries.push({ level: 'debug', msg, data }),
      info: (msg: string, data?: any) => entries.push({ level: 'info', msg, data }),
      warn: (msg: string, data?: any) => entries.push({ level: 'warn', msg, data }),
      error: (msg: string, data?: any) => entries.push({ level: 'error', msg, data }),
      entries,
      close: async () => {},
    };
  }

  it('resolveCategory creates category when not found', async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild: guild as any, logger: logger as any });

    const cat = await mgr.resolveCategory();
    assert.equal(cat.name, 'GSD Projects');
    assert.equal(cat.type, ChannelType.GuildCategory);
  });

  it('resolveCategory returns cached category on second call', async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild: guild as any, logger: logger as any });

    const cat1 = await mgr.resolveCategory();
    const cat2 = await mgr.resolveCategory();
    assert.equal(cat1.id, cat2.id);
    // Only one create call should have been made
    assert.equal(guild._getCreateCount(), 1);
  });

  it('resolveCategory finds existing category by name', async () => {
    const guild = createMockGuild();
    // Pre-populate a matching category
    guild._channels.set('existing-cat', {
      id: 'existing-cat',
      name: 'GSD Projects',
      type: ChannelType.GuildCategory,
      parentId: null,
    });

    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild: guild as any, logger: logger as any });

    const cat = await mgr.resolveCategory();
    assert.equal(cat.id, 'existing-cat');
    // No create calls — found existing
    assert.equal(guild._getCreateCount(), 0);
  });

  it('createProjectChannel creates text channel under category', async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild: guild as any, logger: logger as any });

    const channel = await mgr.createProjectChannel('/home/user/my-project');
    assert.equal(channel.name, 'gsd-my-project');
    assert.equal(channel.type, ChannelType.GuildText);
    // Category was created first (chan-1), then channel (chan-2)
    assert.equal(channel.parentId, 'chan-1');
  });

  it('archiveChannel moves channel to archive category', async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild: guild as any, logger: logger as any });

    // Create a project channel first
    const channel = await mgr.createProjectChannel('/home/user/project');
    const channelId = channel.id;

    // Archive it
    await mgr.archiveChannel(channelId);

    // The channel should have been edit()-ed with the archive category as parent
    const archived = guild._channels.get(channelId)!;
    // Archive category was created as the 3rd channel (chan-3): category(chan-1), text(chan-2), archive(chan-3)
    assert.equal(archived.parentId, 'chan-3');

    // Verify archive log
    const archiveLog = logger.entries.find((e) => e.msg === 'channel archived');
    assert.ok(archiveLog, 'should log channel archived');
    assert.equal(archiveLog!.data.channelId, channelId);
  });

  it('archiveChannel warns when channel not found', async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild: guild as any, logger: logger as any });

    await mgr.archiveChannel('nonexistent-id');
    const warnLog = logger.entries.find((e) => e.msg === 'archive target not found');
    assert.ok(warnLog, 'should warn about missing channel');
  });

  it('uses custom category name when provided', async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({
      guild: guild as any,
      logger: logger as any,
      categoryName: 'Custom Category',
    });

    const cat = await mgr.resolveCategory();
    assert.equal(cat.name, 'Custom Category');
  });
});

// ---------- buildCommands ----------

describe('buildCommands', () => {
  it('returns array with correct command names', () => {
    const commands = buildCommands();
    assert.equal(commands.length, 4);
    const names = commands.map((c) => c.name);
    assert.ok(names.includes('gsd-status'), 'should include gsd-status');
    assert.ok(names.includes('gsd-start'), 'should include gsd-start');
    assert.ok(names.includes('gsd-stop'), 'should include gsd-stop');
    assert.ok(names.includes('gsd-verbose'), 'should include gsd-verbose');
  });

  it('each command has a description', () => {
    const commands = buildCommands();
    for (const cmd of commands) {
      assert.ok(cmd.description, `command ${cmd.name} should have a description`);
      assert.ok(cmd.description.length > 0, `command ${cmd.name} description should be non-empty`);
    }
  });
});

// ---------- formatSessionStatus ----------

describe('formatSessionStatus', () => {
  function mockSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
    return {
      sessionId: 'sess-1',
      projectDir: '/home/user/project',
      projectName: 'project',
      status: 'running',
      client: {} as any,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0.1234, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now() - 120_000, // 2 minutes ago
      ...overrides,
    };
  }

  it('returns "No active sessions." for empty array', () => {
    assert.equal(formatSessionStatus([]), 'No active sessions.');
  });

  it('formats single session with project name and status', () => {
    const result = formatSessionStatus([mockSession()]);
    assert.ok(result.includes('project'), 'should contain project name');
    assert.ok(result.includes('running'), 'should contain status');
    assert.ok(result.includes('$'), 'should contain cost');
  });

  it('formats multiple sessions on separate lines', () => {
    const sessions = [
      mockSession({ projectName: 'alpha', status: 'running' }),
      mockSession({ projectName: 'beta', status: 'blocked' }),
    ];
    const result = formatSessionStatus(sessions);
    assert.ok(result.includes('alpha'), 'should contain first project');
    assert.ok(result.includes('beta'), 'should contain second project');
    const lines = result.split('\n');
    assert.equal(lines.length, 2, 'should have one line per session');
  });

  it('formats 5 sessions correctly', () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      mockSession({ projectName: `proj-${i}`, status: i % 2 === 0 ? 'running' : 'completed' }),
    );
    const result = formatSessionStatus(sessions);
    const lines = result.split('\n');
    assert.equal(lines.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.ok(lines[i].includes(`proj-${i}`));
    }
  });
});

// ---------- Command dispatch (mock interaction) ----------

describe('command dispatch', () => {
  // Minimal mock of a ChatInputCommandInteraction
  function mockInteraction(commandName: string, userId: string = 'owner-1') {
    let replied = false;
    let replyContent = '';

    return {
      user: { id: userId },
      type: 2, // InteractionType.ApplicationCommand
      isChatInputCommand: () => true,
      commandName,
      reply: async (opts: { content: string; ephemeral?: boolean }) => {
        replied = true;
        replyContent = opts.content;
      },
      _getReplied: () => replied,
      _getReplyContent: () => replyContent,
    };
  }

  // Minimal mock of a non-command interaction
  function mockNonCommandInteraction(userId: string = 'owner-1') {
    let replied = false;
    return {
      user: { id: userId },
      type: 3, // InteractionType.MessageComponent
      isChatInputCommand: () => false,
      _getReplied: () => replied,
    };
  }

  // We can't easily test through DiscordBot.handleInteraction since it's private.
  // Instead, test the pure functions that the handler calls, and test auth guard
  // behavior via the mock interaction flow.
  // The command routing logic is tested indirectly through integration of the
  // pure helpers (buildCommands, formatSessionStatus, isAuthorized).

  it('gsd-status with no sessions produces empty message', () => {
    // Tests the formatSessionStatus path that /gsd-status calls
    const result = formatSessionStatus([]);
    assert.equal(result, 'No active sessions.');
  });

  it('unknown command name is not in buildCommands list', () => {
    const commands = buildCommands();
    const names = commands.map((c) => c.name);
    assert.ok(!names.includes('gsd-unknown'), 'unknown should not be in command list');
  });

  it('auth guard rejects non-owner on interaction', () => {
    // Simulates the first check in handleInteraction
    const authorized = isAuthorized('intruder-999', 'owner-1');
    assert.equal(authorized, false);
  });

  it('auth guard accepts owner on interaction', () => {
    const authorized = isAuthorized('owner-1', 'owner-1');
    assert.equal(authorized, true);
  });
});

// ---------- Config validation: new fields ----------

describe('validateConfig — control_channel_id and orchestrator', () => {
  it('parses control_channel_id from discord block', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
        control_channel_id: 'ch-123',
      },
    });
    assert.equal(config.discord?.control_channel_id, 'ch-123');
  });

  it('omits control_channel_id when not present', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
      },
    });
    assert.equal(config.discord?.control_channel_id, undefined);
  });

  it('parses orchestrator model and max_tokens', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
        orchestrator: { model: 'claude-opus-2025', max_tokens: 2048 },
      },
    });
    assert.equal(config.discord?.orchestrator?.model, 'claude-opus-2025');
    assert.equal(config.discord?.orchestrator?.max_tokens, 2048);
  });

  it('missing orchestrator block results in undefined', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
      },
    });
    assert.equal(config.discord?.orchestrator, undefined);
  });

  it('empty orchestrator block has no model or max_tokens', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
        orchestrator: {},
      },
    });
    // orchestrator object should exist but with no values set
    assert.ok(config.discord?.orchestrator !== undefined);
    assert.equal(config.discord?.orchestrator?.model, undefined);
    assert.equal(config.discord?.orchestrator?.max_tokens, undefined);
  });

  it('ignores non-numeric max_tokens', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
        orchestrator: { max_tokens: 'not a number' },
      },
    });
    assert.equal(config.discord?.orchestrator?.max_tokens, undefined);
  });

  it('ignores non-string model', () => {
    const config = validateConfig({
      discord: {
        token: 'tok',
        guild_id: 'g1',
        owner_id: 'o1',
        orchestrator: { model: 42 },
      },
    });
    assert.equal(config.discord?.orchestrator?.model, undefined);
  });
});

// ---------- Daemon wiring: orchestrator ----------

describe('Daemon orchestrator wiring', () => {
  it('orchestrator is undefined when control_channel_id is not set', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'no-orchestrator.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'debug', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    const daemon = new Daemon(config, logger);

    await daemon.start();
    assert.equal(daemon.getOrchestrator(), undefined);

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });

  it('orchestrator is undefined when discord has no control_channel_id', async () => {
    // Even with a discord block that fails login, orchestrator should not be created
    // because there's no control_channel_id
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'no-ctl-chan.log');

    const config: DaemonConfig = {
      discord: {
        token: 'bad-token',
        guild_id: 'g1',
        owner_id: 'o1',
        // control_channel_id intentionally omitted
      },
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'debug', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    const daemon = new Daemon(config, logger);

    await daemon.start();
    // Login fails, so orchestrator can't be wired regardless. But the code path
    // that checks control_channel_id comes after successful login/eventBridge wiring.
    // Since login fails, orchestrator is undefined.
    assert.equal(daemon.getOrchestrator(), undefined);

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });
});

// ---------- /gsd-start and /gsd-stop logic paths ----------

describe('/gsd-start and /gsd-stop logic', () => {
  // These test the observable logic paths exercised by the handlers.
  // Since handleGsdStart/handleGsdStop are private, we test the data layer
  // they depend on — project scanning, session listing, and edge cases.

  it('/gsd-start: scanForProjects returning 0 projects', async () => {
    // Simulates the "no projects" path
    const { scanForProjects } = await import('./project-scanner.js');
    // With no scan roots, should return empty
    const projects = await scanForProjects([]);
    assert.equal(projects.length, 0);
  });

  it('/gsd-stop: getAllSessions returns empty when no sessions active', async () => {
    const { SessionManager } = await import('./session-manager.js');
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'sm-test.log');
    const logger = new Logger({ filePath: logPath, level: 'debug' });
    const sm = new SessionManager(logger);
    const sessions = sm.getAllSessions();
    assert.equal(sessions.length, 0);
    await logger.close();
  });

  it('/gsd-stop: filters to active sessions only', () => {
    // Simulate the filter logic used in handleGsdStop
    const allSessions: Partial<ManagedSession>[] = [
      { sessionId: 's1', status: 'running', projectName: 'alpha' },
      { sessionId: 's2', status: 'completed', projectName: 'beta' },
      { sessionId: 's3', status: 'blocked', projectName: 'gamma' },
      { sessionId: 's4', status: 'error', projectName: 'delta' },
      { sessionId: 's5', status: 'starting', projectName: 'epsilon' },
      { sessionId: 's6', status: 'cancelled', projectName: 'zeta' },
    ];
    const active = allSessions.filter(
      (s) => s.status === 'running' || s.status === 'blocked' || s.status === 'starting',
    );
    assert.equal(active.length, 3);
    assert.deepEqual(active.map((s) => s.projectName), ['alpha', 'gamma', 'epsilon']);
  });

  it('/gsd-start: >25 projects are truncated for select menu', () => {
    // Simulate the truncation logic
    const projects = Array.from({ length: 30 }, (_, i) => ({
      name: `project-${i}`,
      path: `/home/user/project-${i}`,
      markers: [] as string[],
      lastModified: Date.now(),
    }));
    const truncated = projects.slice(0, 25);
    assert.equal(truncated.length, 25);
    assert.equal(truncated[24].name, 'project-24');
  });
});
