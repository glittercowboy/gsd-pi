import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  parseTailscaleStatus,
  getTailscaleStatus,
  isTailscaleInstalled,
  _deps,
} from './tailscale.ts';

// ---------------------------------------------------------------------------
// Test helpers — replace _deps and restore after each test
// ---------------------------------------------------------------------------

function withDeps<T>(overrides: Partial<typeof _deps>, fn: () => T): T {
  const original = { spawnSync: _deps.spawnSync, execFile: _deps.execFile };
  Object.assign(_deps, overrides);
  try {
    return fn();
  } finally {
    Object.assign(_deps, original);
  }
}

// ---------------------------------------------------------------------------
// parseTailscaleStatus — pure function
// ---------------------------------------------------------------------------

describe('Tailscale status parsing', () => {
  it('should strip trailing dot from DNSName', () => {
    const result = parseTailscaleStatus({
      Self: { HostName: 'mac-mini', DNSName: 'mac-mini.tail7e216d.ts.net.' },
      MagicDNSSuffix: 'tail7e216d.ts.net',
    });
    assert.ok(result !== null);
    assert.equal(result!.fqdn, 'mac-mini.tail7e216d.ts.net');
  });

  it('should build valid HTTPS URL from hostname', () => {
    const result = parseTailscaleStatus({
      Self: { HostName: 'mac-mini', DNSName: 'mac-mini.tail7e216d.ts.net.' },
      MagicDNSSuffix: 'tail7e216d.ts.net',
    });
    assert.ok(result !== null);
    assert.equal(result!.url, 'https://mac-mini.tail7e216d.ts.net');
  });

  it('should return null when Self field is missing', () => {
    const result = parseTailscaleStatus({ MagicDNSSuffix: 'tail7e216d.ts.net' });
    assert.equal(result, null);
  });

  it('should parse hostname from status JSON', () => {
    const result = parseTailscaleStatus({
      Self: { HostName: 'my-server', DNSName: 'my-server.tail123.ts.net.' },
      MagicDNSSuffix: 'tail123.ts.net',
    });
    assert.ok(result !== null);
    assert.equal(result!.hostname, 'my-server');
    assert.equal(result!.tailnet, 'tail123.ts.net');
  });

  it('should return null when input is null', () => {
    const result = parseTailscaleStatus(null);
    assert.equal(result, null);
  });

  it('should return null when DNSName field is missing', () => {
    const result = parseTailscaleStatus({
      Self: { HostName: 'mybox' },
      MagicDNSSuffix: 'tail123.ts.net',
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// getTailscaleStatus — I/O function (via _deps injection)
// ---------------------------------------------------------------------------

const validStatusJson = JSON.stringify({
  Self: { HostName: 'mac-mini', DNSName: 'mac-mini.tail7e216d.ts.net.' },
  MagicDNSSuffix: 'tail7e216d.ts.net',
});

describe('getTailscaleStatus via _deps injection', () => {
  it('should return ok:true with info when spawnSync exits 0 with valid JSON', () => {
    const result = withDeps(
      {
        spawnSync: (() => ({
          status: 0,
          stdout: Buffer.from(validStatusJson),
          stderr: Buffer.from(''),
        })) as unknown as typeof spawnSync,
      },
      () => getTailscaleStatus(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.info.hostname, 'mac-mini');
      assert.equal(result.info.fqdn, 'mac-mini.tail7e216d.ts.net');
      assert.equal(result.info.url, 'https://mac-mini.tail7e216d.ts.net');
    }
  });

  it('should return not-connected when spawnSync exits non-zero', () => {
    const result = withDeps(
      {
        spawnSync: (() => ({
          status: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('not connected'),
        })) as unknown as typeof spawnSync,
      },
      () => getTailscaleStatus(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'not-connected');
    }
  });

  it('should return invalid-status when stdout is not valid JSON', () => {
    const result = withDeps(
      {
        spawnSync: (() => ({
          status: 0,
          stdout: Buffer.from('not-json'),
          stderr: Buffer.from(''),
        })) as unknown as typeof spawnSync,
      },
      () => getTailscaleStatus(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid-status');
    }
  });
});

// ---------------------------------------------------------------------------
// isTailscaleInstalled — I/O function (via _deps injection)
// ---------------------------------------------------------------------------

describe('isTailscaleInstalled via _deps injection', () => {
  it('should return false when spawnSync throws (CLI not on PATH)', () => {
    const result = withDeps(
      { spawnSync: (() => { throw new Error('ENOENT'); }) as unknown as typeof spawnSync },
      () => isTailscaleInstalled(),
    );
    assert.equal(result, false);
  });

  it('should return true when spawnSync exits 0', () => {
    const result = withDeps(
      { spawnSync: (() => ({ status: 0, stdout: Buffer.from('1.94.1'), stderr: Buffer.from('') })) as unknown as typeof spawnSync },
      () => isTailscaleInstalled(),
    );
    assert.equal(result, true);
  });
});
