import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXEC_DEFAULTS, runExecSandbox, type ExecSandboxOptions } from '../exec-sandbox.ts';
import { buildExecOptions, executeGsdExec } from '../tools/exec-tool.ts';
import { isContextModeEnabled } from '../preferences-types.ts';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-exec-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function baseOpts(base: string, overrides: Partial<ExecSandboxOptions> = {}): ExecSandboxOptions {
  return {
    baseDir: base,
    clamp_timeout_ms: EXEC_DEFAULTS.clampTimeoutMs,
    default_timeout_ms: 10_000,
    stdout_cap_bytes: 1_024,
    stderr_cap_bytes: 1_024,
    digest_chars: 120,
    env_allowlist: EXEC_DEFAULTS.envAllowlist,
    ...overrides,
  };
}

test('runExecSandbox: captures stdout, persists artifacts, returns digest', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'echo hello world' },
      baseOpts(base),
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.ok(result.digest.includes('hello world'), `digest should contain stdout: ${result.digest}`);
    assert.ok(result.stdout_path.startsWith(join(base, '.gsd', 'exec')), 'stdout path under .gsd/exec');
    assert.equal(readFileSync(result.stdout_path, 'utf-8').trim(), 'hello world');
    const meta = JSON.parse(readFileSync(result.meta_path, 'utf-8')) as Record<string, unknown>;
    assert.equal(meta.runtime, 'bash');
    assert.equal(meta.exit_code, 0);
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: enforces stdout cap and marks truncation', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      // Emit far more than the cap so truncation triggers.
      { runtime: 'bash', script: 'head -c 8000 /dev/urandom | base64' },
      baseOpts(base, { stdout_cap_bytes: 256 }),
    );
    assert.equal(result.stdout_truncated, true, 'should mark stdout truncated');
    assert.ok(result.stdout_bytes <= 256, `stdout_bytes within cap (got ${result.stdout_bytes})`);
    const stdout = readFileSync(result.stdout_path, 'utf-8');
    assert.ok(stdout.endsWith('[truncated: stdout cap reached]\n'), 'truncation marker appended');
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: enforces timeout and surfaces timed_out', async () => {
  const base = freshBase();
  try {
    const started = Date.now();
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'sleep 10' },
      baseOpts(base, { default_timeout_ms: 150, clamp_timeout_ms: 150 }),
    );
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.ok(elapsed < 5_000, `should return well before 10s (took ${elapsed}ms)`);
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: forwards only allowlisted env vars', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'echo PATH=$PATH SECRET=$GSD_TEST_SECRET' },
      baseOpts(base, {
        env_allowlist: [],
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp', GSD_TEST_SECRET: 'should-be-blocked' },
      }),
    );
    const stdout = readFileSync(result.stdout_path, 'utf-8');
    assert.ok(stdout.includes('PATH=/usr/bin:/bin'), 'PATH forwarded');
    assert.ok(!stdout.includes('should-be-blocked'), 'non-allowlisted var blocked');
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: node runtime executes JS', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'node', script: 'console.log("node-ok:" + (1+2))' },
      baseOpts(base),
    );
    assert.equal(result.exit_code, 0);
    assert.ok(result.digest.includes('node-ok:3'));
  } finally {
    cleanup(base);
  }
});

// ── exec-tool executor ────────────────────────────────────────────────────

test('executeGsdExec: runs by default when context_mode is unset', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo default-on-run' },
      { baseDir: base, preferences: {} },
    );
    assert.ok(!result.isError, 'should succeed with no preferences');
    assert.equal(result.details.operation, 'gsd_exec');
    assert.equal(result.details.exit_code, 0);
    assert.ok(result.content[0].text.includes('default-on-run'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: runs when preferences is null (fresh project)', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo null-prefs-run' },
      { baseDir: base, preferences: null },
    );
    assert.ok(!result.isError, 'null preferences should not disable');
    assert.ok(result.content[0].text.includes('null-prefs-run'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: blocked only when context_mode.enabled=false', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo should-not-run' },
      { baseDir: base, preferences: { context_mode: { enabled: false } } },
    );
    assert.equal(result.isError, true);
    assert.equal((result.details as { error?: string }).error, 'context_mode_disabled');
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: runs when enabled explicitly set to true', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo explicit-on' },
      { baseDir: base, preferences: { context_mode: { enabled: true } } },
    );
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('explicit-on'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: rejects empty script', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: '   ' },
      { baseDir: base, preferences: { context_mode: { enabled: true } } },
    );
    assert.equal(result.isError, true);
    assert.equal((result.details as { error?: string }).error, 'invalid_params');
  } finally {
    cleanup(base);
  }
});

test('isContextModeEnabled: defaults to true; only explicit false disables', () => {
  assert.equal(isContextModeEnabled(undefined), true, 'undefined prefs → on');
  assert.equal(isContextModeEnabled(null), true, 'null prefs → on');
  assert.equal(isContextModeEnabled({}), true, 'empty prefs → on');
  assert.equal(isContextModeEnabled({ context_mode: {} }), true, 'empty block → on');
  assert.equal(isContextModeEnabled({ context_mode: { enabled: true } }), true);
  assert.equal(isContextModeEnabled({ context_mode: { enabled: false } }), false);
});

test('buildExecOptions: clamps out-of-range values to safe defaults', () => {
  const opts = buildExecOptions('/tmp/base', {
    enabled: true,
    exec_timeout_ms: 999_999_999,
    exec_stdout_cap_bytes: 1,
    exec_digest_chars: -20,
  });
  assert.equal(opts.default_timeout_ms, EXEC_DEFAULTS.clampTimeoutMs, 'timeout clamped to upper bound');
  assert.equal(opts.stdout_cap_bytes, 4_096, 'stdout cap clamped to floor');
  assert.equal(opts.digest_chars, 0, 'digest chars clamped to floor');
});
