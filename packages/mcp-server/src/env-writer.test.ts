// @gsd-build/mcp-server — Tests for env-writer utilities
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkExistingEnvKeys,
  detectDestination,
  writeEnvKey,
  applySecrets,
  isSafeEnvVarKey,
  isSupportedDeploymentEnvironment,
  resolveProjectEnvFilePath,
  shellEscapeSingle,
} from './env-writer.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

// ---------------------------------------------------------------------------
// checkExistingEnvKeys
// ---------------------------------------------------------------------------

describe('checkExistingEnvKeys', () => {
  it('finds key in .env file', async () => {
    const tmp = makeTempDir('env-check');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'API_KEY=secret123\nOTHER=val\n');
      const result = await checkExistingEnvKeys(['API_KEY'], envPath);
      assert.deepStrictEqual(result, ['API_KEY']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds key in process.env', async () => {
    const tmp = makeTempDir('env-check');
    const saved = process.env.GSD_MCP_TEST_KEY_1;
    try {
      process.env.GSD_MCP_TEST_KEY_1 = 'some-value';
      const envPath = join(tmp, '.env');
      const result = await checkExistingEnvKeys(['GSD_MCP_TEST_KEY_1'], envPath);
      assert.deepStrictEqual(result, ['GSD_MCP_TEST_KEY_1']);
    } finally {
      delete process.env.GSD_MCP_TEST_KEY_1;
      if (saved !== undefined) process.env.GSD_MCP_TEST_KEY_1 = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty for missing keys', async () => {
    const tmp = makeTempDir('env-check');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'OTHER=val\n');
      delete process.env.DEFINITELY_NOT_SET_MCP_XYZ;
      const result = await checkExistingEnvKeys(['DEFINITELY_NOT_SET_MCP_XYZ'], envPath);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles missing .env file gracefully', async () => {
    const tmp = makeTempDir('env-check');
    try {
      const envPath = join(tmp, 'nonexistent.env');
      delete process.env.DEFINITELY_NOT_SET_MCP_XYZ;
      const result = await checkExistingEnvKeys(['DEFINITELY_NOT_SET_MCP_XYZ'], envPath);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// detectDestination
// ---------------------------------------------------------------------------

describe('detectDestination', () => {
  it('returns vercel when vercel.json exists', () => {
    const tmp = makeTempDir('dest');
    try {
      writeFileSync(join(tmp, 'vercel.json'), '{}');
      assert.equal(detectDestination(tmp), 'vercel');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns convex when convex/ dir exists', () => {
    const tmp = makeTempDir('dest');
    try {
      mkdirSync(join(tmp, 'convex'));
      assert.equal(detectDestination(tmp), 'convex');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns dotenv when neither exists', () => {
    const tmp = makeTempDir('dest');
    try {
      assert.equal(detectDestination(tmp), 'dotenv');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('vercel takes priority over convex', () => {
    const tmp = makeTempDir('dest');
    try {
      writeFileSync(join(tmp, 'vercel.json'), '{}');
      mkdirSync(join(tmp, 'convex'));
      assert.equal(detectDestination(tmp), 'vercel');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeEnvKey
// ---------------------------------------------------------------------------

describe('writeEnvKey', () => {
  it('creates .env file with new key', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      await writeEnvKey(envPath, 'NEW_KEY', 'new-value');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes('NEW_KEY=new-value'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('updates existing key in-place', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'EXISTING=old\nOTHER=keep\n');
      await writeEnvKey(envPath, 'EXISTING', 'new');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes('EXISTING=new'));
      assert.ok(content.includes('OTHER=keep'));
      assert.ok(!content.includes('old'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('escapes newlines in values', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      await writeEnvKey(envPath, 'MULTI', 'line1\nline2');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes('MULTI=line1\\nline2'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects non-string values', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      await assert.rejects(
        () => writeEnvKey(envPath, 'KEY', undefined as unknown as string),
        /expects a string value/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not follow symlinked env files when writing', async () => {
    const tmp = makeTempDir('write');
    const outside = makeTempDir('write-outside');
    try {
      const outsideEnv = join(outside, '.env');
      writeFileSync(outsideEnv, 'SECRET=outside\n');
      symlinkSync(outsideEnv, join(tmp, '.env'));

      await assert.rejects(
        () => writeEnvKey(join(tmp, '.env'), 'SECRET', 'inside'),
        /ELOOP|symbolic link|symlink/i,
      );
      assert.equal(readFileSync(outsideEnv, 'utf8'), 'SECRET=outside\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProjectEnvFilePath
// ---------------------------------------------------------------------------

describe('resolveProjectEnvFilePath', () => {
  it('allows .env under the project root', () => {
    const tmp = makeTempDir('env-path');
    try {
      assert.equal(resolveProjectEnvFilePath(tmp, '.env'), join(realpathSync.native(tmp), '.env'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects envFilePath outside the project root', () => {
    const tmp = makeTempDir('env-path');
    try {
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, '../outside.env'),
        /inside the project directory/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects symlinked parent directories that escape the project root', () => {
    const tmp = makeTempDir('env-path');
    const outside = makeTempDir('env-path-outside');
    try {
      symlinkSync(outside, join(tmp, 'linked-outside'), 'dir');
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, 'linked-outside/.env'),
        /inside the project directory/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects existing env files that are symlinks outside the project root', () => {
    const tmp = makeTempDir('env-path');
    const outside = makeTempDir('env-path-outside');
    try {
      writeFileSync(join(outside, '.env'), 'SECRET=outside\n');
      symlinkSync(join(outside, '.env'), join(tmp, '.env'));
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, '.env'),
        /inside the project directory/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// applySecrets (dotenv)
// ---------------------------------------------------------------------------

describe('applySecrets', () => {
  const savedKeys: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('writes keys to .env and hydrates process.env', async () => {
    const tmp = makeTempDir('apply');
    const envPath = join(tmp, '.env');
    savedKeys.GSD_APPLY_TEST_A = process.env.GSD_APPLY_TEST_A;
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'GSD_APPLY_TEST_A', value: 'val-a' }],
        'dotenv',
        { envFilePath: envPath },
      );
      assert.deepStrictEqual(applied, ['GSD_APPLY_TEST_A']);
      assert.deepStrictEqual(errors, []);
      assert.equal(process.env.GSD_APPLY_TEST_A, 'val-a');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes('GSD_APPLY_TEST_A=val-a'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns errors for invalid vercel environment', async () => {
    const tmp = makeTempDir('apply');
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'KEY', value: 'val' }],
        'vercel',
        {
          envFilePath: join(tmp, '.env'),
          environment: 'staging' as 'development',
          execFn: async () => ({ code: 0, stderr: '' }),
        },
      );
      assert.deepStrictEqual(applied, []);
      assert.ok(errors[0]?.includes('unsupported'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

describe('isSafeEnvVarKey', () => {
  it('accepts valid keys', () => {
    assert.ok(isSafeEnvVarKey('API_KEY'));
    assert.ok(isSafeEnvVarKey('_PRIVATE'));
    assert.ok(isSafeEnvVarKey('key123'));
  });

  it('rejects invalid keys', () => {
    assert.ok(!isSafeEnvVarKey('123BAD'));
    assert.ok(!isSafeEnvVarKey('has-dash'));
    assert.ok(!isSafeEnvVarKey('has space'));
    assert.ok(!isSafeEnvVarKey(''));
  });
});

describe('isSupportedDeploymentEnvironment', () => {
  it('accepts valid environments', () => {
    assert.ok(isSupportedDeploymentEnvironment('development'));
    assert.ok(isSupportedDeploymentEnvironment('preview'));
    assert.ok(isSupportedDeploymentEnvironment('production'));
  });

  it('rejects invalid environments', () => {
    assert.ok(!isSupportedDeploymentEnvironment('staging'));
    assert.ok(!isSupportedDeploymentEnvironment('test'));
  });
});

describe('shellEscapeSingle', () => {
  it('wraps in single quotes', () => {
    assert.equal(shellEscapeSingle('hello'), "'hello'");
  });

  it('escapes embedded single quotes', () => {
    assert.equal(shellEscapeSingle("it's"), "'it'\\''s'");
  });
});
