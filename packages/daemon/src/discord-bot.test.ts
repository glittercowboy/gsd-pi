import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAuthorized, validateDiscordConfig } from './discord-bot.js';
import { Daemon } from './daemon.js';
import { Logger } from './logger.js';
import type { DaemonConfig, LogEntry } from './types.js';

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
