import { describe, it, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { resolveConfigPath, loadConfig, validateConfig } from './config.js';
import { Logger } from './logger.js';
import { Daemon } from './daemon.js';
import { SessionManager } from './session-manager.js';
import type { DaemonConfig, LogEntry } from './types.js';

// ---------- helpers ----------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `daemon-test-${randomUUID().slice(0, 8)}-`));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ---------- config ----------

describe('resolveConfigPath', () => {
  it('prefers explicit CLI path', () => {
    const p = resolveConfigPath('/custom/config.yaml');
    assert.equal(p, '/custom/config.yaml');
  });

  it('expands ~ in CLI path', () => {
    const p = resolveConfigPath('~/my-daemon.yaml');
    assert.ok(p.startsWith(homedir()));
    assert.ok(p.endsWith('my-daemon.yaml'));
  });

  it('falls back to GSD_DAEMON_CONFIG env var', () => {
    const prev = process.env['GSD_DAEMON_CONFIG'];
    try {
      process.env['GSD_DAEMON_CONFIG'] = '/env/path.yaml';
      const p = resolveConfigPath();
      assert.equal(p, '/env/path.yaml');
    } finally {
      if (prev === undefined) delete process.env['GSD_DAEMON_CONFIG'];
      else process.env['GSD_DAEMON_CONFIG'] = prev;
    }
  });

  it('defaults to ~/.gsd/daemon.yaml', () => {
    const prev = process.env['GSD_DAEMON_CONFIG'];
    try {
      delete process.env['GSD_DAEMON_CONFIG'];
      const p = resolveConfigPath();
      assert.equal(p, join(homedir(), '.gsd', 'daemon.yaml'));
    } finally {
      if (prev !== undefined) process.env['GSD_DAEMON_CONFIG'] = prev;
    }
  });
});

describe('loadConfig', () => {
  // Save and clear DISCORD_BOT_TOKEN for this suite — env override interferes with file-token assertions
  let savedToken: string | undefined;
  before(() => {
    savedToken = process.env['DISCORD_BOT_TOKEN'];
    delete process.env['DISCORD_BOT_TOKEN'];
  });
  afterEach(() => {}); // cleanup dirs handled by top-level afterEach
  // Restore after all tests in this suite
  after(() => {
    if (savedToken !== undefined) process.env['DISCORD_BOT_TOKEN'] = savedToken;
  });

  it('parses valid YAML config', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'daemon.yaml');
    writeFileSync(configPath, `
discord:
  token: "test-token-123"
  guild_id: "g1"
  owner_id: "o1"
projects:
  scan_roots:
    - ~/projects
    - /absolute/path
log:
  file: ~/logs/daemon.log
  level: debug
  max_size_mb: 100
`);
    const cfg = loadConfig(configPath);
    assert.equal(cfg.discord?.token, 'test-token-123');
    assert.equal(cfg.discord?.guild_id, 'g1');
    assert.equal(cfg.log.level, 'debug');
    assert.equal(cfg.log.max_size_mb, 100);
    assert.ok(cfg.log.file.startsWith(homedir()));
    assert.ok(cfg.projects.scan_roots[0]!.startsWith(homedir()));
    assert.equal(cfg.projects.scan_roots[1], '/absolute/path');
  });

  it('returns defaults when config file is missing', () => {
    const cfg = loadConfig('/nonexistent/path/daemon.yaml');
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
    assert.ok(cfg.log.file.endsWith('daemon.log'));
    assert.deepEqual(cfg.projects.scan_roots, []);
    assert.equal(cfg.discord, undefined);
  });

  it('throws on malformed YAML', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'bad.yaml');
    writeFileSync(configPath, ':\n  :\n    bad: [unclosed');
    assert.throws(() => loadConfig(configPath), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('Failed to parse YAML'));
      assert.ok(err.message.includes(configPath));
      return true;
    });
  });

  it('returns defaults for empty YAML file', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'empty.yaml');
    writeFileSync(configPath, '');
    const cfg = loadConfig(configPath);
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
    assert.deepEqual(cfg.projects.scan_roots, []);
  });
});

describe('validateConfig', () => {
  // Save and clear DISCORD_BOT_TOKEN for tests that don't expect it
  let savedToken: string | undefined;
  before(() => {
    savedToken = process.env['DISCORD_BOT_TOKEN'];
    delete process.env['DISCORD_BOT_TOKEN'];
  });
  after(() => {
    if (savedToken !== undefined) process.env['DISCORD_BOT_TOKEN'] = savedToken;
  });

  it('fills remaining defaults for partial config', () => {
    const cfg = validateConfig({ projects: { scan_roots: ['/a'] } });
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
    assert.ok(cfg.log.file.endsWith('daemon.log'));
    assert.deepEqual(cfg.projects.scan_roots, ['/a']);
    assert.equal(cfg.discord, undefined);
  });

  it('falls back to info for invalid log level', () => {
    const cfg = validateConfig({ log: { level: 'trace' } });
    assert.equal(cfg.log.level, 'info');
  });

  it('returns full defaults for null input', () => {
    const cfg = validateConfig(null);
    assert.equal(cfg.log.level, 'info');
    assert.equal(cfg.log.max_size_mb, 50);
  });

  it('returns full defaults for non-object input', () => {
    const cfg = validateConfig('not-an-object');
    assert.equal(cfg.log.level, 'info');
  });

  it('expands ~ in log file path', () => {
    const cfg = validateConfig({ log: { file: '~/my.log' } });
    assert.ok(cfg.log.file.startsWith(homedir()));
    assert.ok(cfg.log.file.endsWith('my.log'));
  });

  it('overrides discord token from DISCORD_BOT_TOKEN env var', () => {
    const prev = process.env['DISCORD_BOT_TOKEN'];
    try {
      process.env['DISCORD_BOT_TOKEN'] = 'env-override-token';
      const cfg = validateConfig({
        discord: { token: 'file-token', guild_id: 'g1', owner_id: 'o1' },
      });
      assert.equal(cfg.discord?.token, 'env-override-token');
      assert.equal(cfg.discord?.guild_id, 'g1');
    } finally {
      if (prev === undefined) delete process.env['DISCORD_BOT_TOKEN'];
      else process.env['DISCORD_BOT_TOKEN'] = prev;
    }
  });

  it('creates discord block from env var even when absent in config', () => {
    const prev = process.env['DISCORD_BOT_TOKEN'];
    try {
      process.env['DISCORD_BOT_TOKEN'] = 'env-only-token';
      const cfg = validateConfig({});
      assert.equal(cfg.discord?.token, 'env-only-token');
    } finally {
      if (prev === undefined) delete process.env['DISCORD_BOT_TOKEN'];
      else process.env['DISCORD_BOT_TOKEN'] = prev;
    }
  });
});

// ---------- logger ----------

describe('Logger', () => {
  it('writes JSON-lines entries to file', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'test.log');

    const logger = new Logger({ filePath: logPath, level: 'debug' });
    logger.info('hello world');
    logger.debug('detail', { key: 'val' });
    await logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const entry0: LogEntry = JSON.parse(lines[0]!);
    assert.equal(entry0.level, 'info');
    assert.equal(entry0.msg, 'hello world');
    assert.ok(entry0.ts); // ISO-8601

    const entry1: LogEntry = JSON.parse(lines[1]!);
    assert.equal(entry1.level, 'debug');
    assert.equal(entry1.msg, 'detail');
    assert.deepEqual(entry1.data, { key: 'val' });
  });

  it('filters entries below configured level', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'filter.log');

    const logger = new Logger({ filePath: logPath, level: 'warn' });
    logger.debug('should not appear');
    logger.info('should not appear either');
    logger.warn('visible warning');
    logger.error('visible error');
    await logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as LogEntry).level, 'warn');
    assert.equal((JSON.parse(lines[1]!) as LogEntry).level, 'error');
  });

  it('close() resolves after stream ends', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'close.log');

    const logger = new Logger({ filePath: logPath, level: 'info' });
    logger.info('before close');
    await logger.close();

    // File should be readable and contain the entry
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('before close'));
  });

  it('creates parent directories if they do not exist', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'nested', 'deep', 'test.log');

    const logger = new Logger({ filePath: logPath, level: 'info' });
    logger.info('nested dir test');
    await logger.close();

    assert.ok(existsSync(logPath));
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('nested dir test'));
  });

  it('does not include data field when not provided', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'nodata.log');

    const logger = new Logger({ filePath: logPath, level: 'info' });
    logger.info('no extra data');
    await logger.close();

    const entry: LogEntry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    assert.equal(entry.data, undefined);
    // Also verify the raw JSON doesn't contain "data" key
    assert.ok(!readFileSync(logPath, 'utf-8').includes('"data"'));
  });
});

// ---------- token safety ----------

describe('token safety', () => {
  it('discord token never appears in log output', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'token-safety.log');

    // Config with a token
    const prev = process.env['DISCORD_BOT_TOKEN'];
    try {
      process.env['DISCORD_BOT_TOKEN'] = 'super-secret-token-value';
      const cfg = validateConfig({});

      const logger = new Logger({ filePath: logPath, level: 'debug' });
      // Log the config object — token must not leak
      logger.info('config loaded', { discord_configured: !!cfg.discord });
      logger.debug('startup complete');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(!content.includes('super-secret-token-value'));
    } finally {
      if (prev === undefined) delete process.env['DISCORD_BOT_TOKEN'];
      else process.env['DISCORD_BOT_TOKEN'] = prev;
    }
  });
});

// ---------- daemon lifecycle ----------

// Resolve the dist/ directory for spawning CLI
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Daemon', () => {
  it('logs lifecycle events on start and shutdown', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'daemon-lifecycle.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: ['/a', '/b'] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    // start() should have logged 'daemon started'
    // shutdown() directly — we override process.exit to prevent test runner from dying
    const origExit = process.exit;
    let exitCode: number | undefined;
    // @ts-expect-error — overriding process.exit for test
    process.exit = (code?: number) => { exitCode = code ?? 0; };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    assert.equal(exitCode, 0);

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    // First line: daemon started
    const startEntry: LogEntry = JSON.parse(lines[0]!);
    assert.equal(startEntry.msg, 'daemon started');
    assert.equal(startEntry.data?.scan_roots, 2);
    assert.equal(startEntry.data?.discord_configured, false);

    // Second line: daemon shutting down
    const stopEntry: LogEntry = JSON.parse(lines[1]!);
    assert.equal(stopEntry.msg, 'daemon shutting down');
  });

  it('shutdown is idempotent — second call is a no-op', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'idempotent.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    const origExit = process.exit;
    let exitCount = 0;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => { exitCount++; };
    try {
      await daemon.shutdown();
      await daemon.shutdown(); // second call — should be no-op
    } finally {
      process.exit = origExit;
    }

    assert.equal(exitCount, 1, 'process.exit should be called exactly once');

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const shutdownLines = lines.filter(l => {
      const e: LogEntry = JSON.parse(l);
      return e.msg === 'daemon shutting down';
    });
    assert.equal(shutdownLines.length, 1, 'shutdown log should appear exactly once');
  });
});

// ---------- Health heartbeat ----------

describe('Health heartbeat', () => {
  it('logs health entry with expected fields after interval tick', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'health.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    // Use 50ms interval for fast test
    const daemon = new Daemon(config, logger, 50);

    await daemon.start();

    // Wait for at least one health tick
    await new Promise((r) => setTimeout(r, 120));

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const healthLines = lines.filter((l) => {
      const e: LogEntry = JSON.parse(l);
      return e.msg === 'health';
    });

    assert.ok(healthLines.length >= 1, 'should have at least one health log entry');

    const entry: LogEntry = JSON.parse(healthLines[0]!);
    assert.equal(entry.msg, 'health');
    assert.equal(typeof entry.data?.uptime_s, 'number');
    assert.equal(typeof entry.data?.active_sessions, 'number');
    assert.equal(typeof entry.data?.discord_connected, 'boolean');
    assert.equal(typeof entry.data?.memory_rss_mb, 'number');
    assert.equal(entry.data?.discord_connected, false); // no discord configured
    assert.equal(entry.data?.active_sessions, 0); // no sessions
  });

  it('health timer is cleared on shutdown — no lingering intervals', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'health-cleanup.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    // Use 50ms interval
    const daemon = new Daemon(config, logger, 50);

    await daemon.start();

    // Wait for one tick
    await new Promise((r) => setTimeout(r, 80));

    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    // Count health entries at shutdown
    const contentAtShutdown = readFileSync(logPath, 'utf-8');
    const healthCountAtShutdown = contentAtShutdown
      .trim()
      .split('\n')
      .filter((l) => JSON.parse(l).msg === 'health').length;

    // Wait another interval — no new health entries should appear
    await new Promise((r) => setTimeout(r, 120));

    // Re-read (logger is closed, so file shouldn't change)
    const contentAfterWait = readFileSync(logPath, 'utf-8');
    const healthCountAfterWait = contentAfterWait
      .trim()
      .split('\n')
      .filter((l) => JSON.parse(l).msg === 'health').length;

    assert.equal(
      healthCountAfterWait,
      healthCountAtShutdown,
      'no new health entries should appear after shutdown',
    );
  });
});

describe('CLI integration', () => {
  it('--help prints usage and exits 0', () => {
    const result = execFileSync(
      process.execPath,
      [join(__dirname, 'cli.js'), '--help'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    assert.ok(result.includes('Usage: gsd-daemon'));
    assert.ok(result.includes('--config'));
    assert.ok(result.includes('--verbose'));
  });

  it('starts, logs to file, and exits cleanly on SIGTERM', { timeout: 15000 }, async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'integration.log');
    const configPath = join(dir, 'daemon.yaml');

    writeFileSync(configPath, `
projects:
  scan_roots:
    - /tmp/test-project
log:
  file: "${logPath}"
  level: info
  max_size_mb: 10
`);

    // Use execFile with a wrapper script approach: spawn, wait for start, SIGTERM, verify
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(__dirname, 'cli.js'), '--config', configPath],
        { stdio: 'ignore' },
      );

      let resolved = false;
      child.on('error', (err) => { if (!resolved) { resolved = true; reject(err); } });
      child.on('exit', (code) => { if (!resolved) { resolved = true; resolve(code ?? 1); } });

      // Poll for startup, then send SIGTERM
      const poll = setInterval(() => {
        if (existsSync(logPath)) {
          const content = readFileSync(logPath, 'utf-8');
          if (content.includes('daemon started')) {
            clearInterval(poll);
            child.kill('SIGTERM');
          }
        }
      }, 100);

      // Safety: kill child if it takes too long
      setTimeout(() => {
        clearInterval(poll);
        if (!resolved) {
          child.kill('SIGKILL');
          resolved = true;
          reject(new Error('timed out waiting for daemon'));
        }
      }, 10000);
    });

    assert.equal(exitCode, 0, 'daemon should exit with code 0 on SIGTERM');

    // Small delay for filesystem flush
    await new Promise(r => setTimeout(r, 100));

    // Verify log file contents
    const finalContent = readFileSync(logPath, 'utf-8');
    assert.ok(finalContent.includes('daemon started'), 'log should contain startup entry');
    assert.ok(finalContent.includes('daemon shutting down'), 'log should contain shutdown entry');

    // Verify log entries are valid JSON-lines
    const lines = finalContent.trim().split('\n');
    for (const line of lines) {
      const entry: LogEntry = JSON.parse(line);
      assert.ok(entry.ts, 'each entry should have a timestamp');
      assert.ok(entry.level, 'each entry should have a level');
      assert.ok(entry.msg, 'each entry should have a message');
    }
  });

  it('exits with code 1 on invalid config', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, 'bad.yaml');
    writeFileSync(configPath, ':\n  :\n    bad: [unclosed');

    try {
      execFileSync(
        process.execPath,
        [join(__dirname, 'cli.js'), '--config', configPath],
        { encoding: 'utf-8', timeout: 5000 },
      );
      assert.fail('should have thrown');
    } catch (err: unknown) {
      // execFileSync throws on non-zero exit
      const execErr = err as { status: number; stderr: string };
      assert.equal(execErr.status, 1);
      assert.ok(execErr.stderr.includes('fatal'));
    }
  });
});

// ---------- Daemon + SessionManager integration ----------

describe('Daemon integration', () => {
  it('getSessionManager() returns SessionManager after start()', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'daemon-sm.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    const sm = daemon.getSessionManager();
    assert.ok(sm instanceof SessionManager);

    // Clean shutdown
    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });

  it('getSessionManager() throws before start()', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'daemon-nostart.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    const daemon = new Daemon(config, logger);

    assert.throws(
      () => daemon.getSessionManager(),
      (err: Error) => {
        assert.ok(err.message.includes('Daemon not started'));
        return true;
      }
    );

    // Close logger to prevent async write stream from hitting cleaned-up tmpdir
    await logger.close();
  });

  it('scanProjects() delegates to scanForProjects with configured roots', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'daemon-scan.log');

    // Create a fake project root with a project that has a .git marker
    const scanRoot = join(dir, 'projects');
    mkdirSync(scanRoot);
    const projectDir = join(scanRoot, 'my-project');
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, '.git'));

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [scanRoot] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    const projects = await daemon.scanProjects();
    assert.ok(projects.length >= 1);
    const found = projects.find(p => p.name === 'my-project');
    assert.ok(found);
    assert.ok(found.markers.includes('git'));

    // Clean shutdown
    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });

  it('shutdown cleans up sessionManager before closing logger', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, 'daemon-cleanup.log');

    const config: DaemonConfig = {
      discord: undefined,
      projects: { scan_roots: [] },
      log: { file: logPath, level: 'info', max_size_mb: 50 },
    };

    const logger = new Logger({ filePath: logPath, level: 'info' });
    const daemon = new Daemon(config, logger);

    await daemon.start();

    // Access sessionManager to verify it exists
    const sm = daemon.getSessionManager();
    assert.ok(sm);

    // Shutdown — should not throw even though sessionManager has no active sessions
    const origExit = process.exit;
    // @ts-expect-error — overriding process.exit for test
    process.exit = () => {};
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }

    // Verify log contains both started and shutting down
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('daemon started'));
    assert.ok(content.includes('daemon shutting down'));
  });
});
