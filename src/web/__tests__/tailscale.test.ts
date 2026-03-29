import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';

import {
  parseTailscaleStatus,
  buildServeCommand,
  buildServeResetCommand,
  getInstallCommand,
  isTailscaleInstalled,
  getTailscaleStatus,
  startTailscaleServe,
  stopTailscaleServe,
  stopTailscaleServeSync,
  TailscaleServeError,
  _deps,
} from '../tailscale.ts';

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

async function withDepsAsync<T>(overrides: Partial<typeof _deps>, fn: () => Promise<T>): Promise<T> {
  const original = { spawnSync: _deps.spawnSync, execFile: _deps.execFile };
  Object.assign(_deps, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(_deps, original);
  }
}

// ---------------------------------------------------------------------------
// parseTailscaleStatus — pure function
// ---------------------------------------------------------------------------

test('parseTailscaleStatus returns correct fields with trailing dot stripped', () => {
  const result = parseTailscaleStatus({
    Self: { HostName: 'Mac mini', DNSName: 'mac-mini.tail7e216d.ts.net.' },
    MagicDNSSuffix: 'tail7e216d.ts.net',
  });
  assert.ok(result !== null);
  assert.equal(result!.hostname, 'Mac mini');
  assert.equal(result!.tailnet, 'tail7e216d.ts.net');
  assert.equal(result!.fqdn, 'mac-mini.tail7e216d.ts.net');
  assert.equal(result!.url, 'https://mac-mini.tail7e216d.ts.net');
});

test('parseTailscaleStatus works when DNSName has no trailing dot', () => {
  const result = parseTailscaleStatus({
    Self: { HostName: 'mybox', DNSName: 'mybox.tail123.ts.net' },
    MagicDNSSuffix: 'tail123.ts.net',
  });
  assert.ok(result !== null);
  assert.equal(result!.fqdn, 'mybox.tail123.ts.net');
  assert.equal(result!.url, 'https://mybox.tail123.ts.net');
});

test('parseTailscaleStatus returns null when Self field is missing', () => {
  const result = parseTailscaleStatus({ MagicDNSSuffix: 'tail123.ts.net' });
  assert.equal(result, null);
});

test('parseTailscaleStatus returns null when DNSName field is missing', () => {
  const result = parseTailscaleStatus({
    Self: { HostName: 'mybox' },
    MagicDNSSuffix: 'tail123.ts.net',
  });
  assert.equal(result, null);
});

test('parseTailscaleStatus returns null when MagicDNSSuffix field is missing', () => {
  const result = parseTailscaleStatus({
    Self: { HostName: 'mybox', DNSName: 'mybox.tail123.ts.net.' },
  });
  assert.equal(result, null);
});

test('parseTailscaleStatus returns null when input is null', () => {
  const result = parseTailscaleStatus(null);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// buildServeCommand — pure function
// ---------------------------------------------------------------------------

test('buildServeCommand returns correct args array', () => {
  const result = buildServeCommand(3456);
  assert.deepEqual(result, [
    'serve',
    '--bg',
    '--https',
    '443',
    'http://127.0.0.1:3456',
  ]);
});

test('buildServeCommand includes port in URL', () => {
  const result = buildServeCommand(8080);
  assert.ok(result[4].includes('8080'));
});

// ---------------------------------------------------------------------------
// buildServeResetCommand — pure function
// ---------------------------------------------------------------------------

test('buildServeResetCommand returns ["serve", "reset"]', () => {
  assert.deepEqual(buildServeResetCommand(), ['serve', 'reset']);
});

// ---------------------------------------------------------------------------
// getInstallCommand — pure function
// ---------------------------------------------------------------------------

test('getInstallCommand returns brew install for darwin', () => {
  assert.equal(getInstallCommand('darwin'), 'brew install tailscale');
});

test('getInstallCommand returns winget install for win32', () => {
  assert.equal(getInstallCommand('win32'), 'winget install Tailscale.Tailscale');
});

test('getInstallCommand returns curl script for linux', () => {
  const cmd = getInstallCommand('linux');
  assert.ok(cmd.startsWith('curl'));
  assert.ok(cmd.includes('tailscale.com/install.sh'));
});

test('getInstallCommand returns curl script for other platforms', () => {
  const cmd = getInstallCommand('freebsd');
  assert.ok(cmd.startsWith('curl'));
});

// ---------------------------------------------------------------------------
// isTailscaleInstalled — I/O function (via _deps injection)
// ---------------------------------------------------------------------------

test('isTailscaleInstalled returns true when spawnSync exits 0', () => {
  const result = withDeps(
    { spawnSync: (() => ({ status: 0, stdout: Buffer.from('1.94.1'), stderr: Buffer.from('') })) as unknown as typeof spawnSync },
    () => isTailscaleInstalled(),
  );
  assert.equal(result, true);
});

test('isTailscaleInstalled returns false when spawnSync exits non-zero', () => {
  const result = withDeps(
    { spawnSync: (() => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('not found') })) as unknown as typeof spawnSync },
    () => isTailscaleInstalled(),
  );
  assert.equal(result, false);
});

test('isTailscaleInstalled returns false when spawnSync throws', () => {
  const result = withDeps(
    { spawnSync: (() => { throw new Error('ENOENT'); }) as unknown as typeof spawnSync },
    () => isTailscaleInstalled(),
  );
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// getTailscaleStatus — I/O function (via _deps injection)
// ---------------------------------------------------------------------------

const validStatusJson = JSON.stringify({
  Self: { HostName: 'Mac mini', DNSName: 'mac-mini.tail7e216d.ts.net.' },
  MagicDNSSuffix: 'tail7e216d.ts.net',
});

test('getTailscaleStatus returns ok result when spawnSync succeeds with valid JSON', () => {
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
    assert.equal(result.info.hostname, 'Mac mini');
    assert.equal(result.info.fqdn, 'mac-mini.tail7e216d.ts.net');
  }
});

test('getTailscaleStatus returns not-connected when spawnSync exits non-zero', () => {
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

test('getTailscaleStatus returns invalid-status when stdout is not valid JSON', () => {
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

test('getTailscaleStatus returns cli-error when spawnSync throws', () => {
  const result = withDeps(
    { spawnSync: (() => { throw new Error('ENOENT tailscale'); }) as unknown as typeof spawnSync },
    () => getTailscaleStatus(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'cli-error');
    assert.ok(result.stderr !== undefined);
  }
});

test('getTailscaleStatus returns invalid-status when JSON has no Self field', () => {
  const result = withDeps(
    {
      spawnSync: (() => ({
        status: 0,
        stdout: Buffer.from(JSON.stringify({ MagicDNSSuffix: 'tail.ts.net' })),
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

// ---------------------------------------------------------------------------
// startTailscaleServe — async I/O function (via _deps injection)
// ---------------------------------------------------------------------------

test('startTailscaleServe calls execFile with buildServeCommand args', async () => {
  let capturedArgs: string[] | undefined;
  const fakeExecFile = ((_cmd: string, args: string[], cb: (err: Error | null) => void) => {
    capturedArgs = args;
    cb(null);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;

  await withDepsAsync({ execFile: fakeExecFile }, () => startTailscaleServe(3456));
  assert.ok(capturedArgs !== undefined);
  assert.deepEqual(capturedArgs, ['serve', '--bg', '--https', '443', 'http://127.0.0.1:3456']);
});

test('startTailscaleServe throws TailscaleServeError on execFile failure', async () => {
  const fakeExecFile = ((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    const err = Object.assign(new Error('tailscale serve failed'), { code: 1, stderr: 'daemon not running' });
    cb(err);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;

  await assert.rejects(
    () => withDepsAsync({ execFile: fakeExecFile }, () => startTailscaleServe(3456)),
    (err: unknown) => {
      assert.ok(err instanceof TailscaleServeError);
      assert.ok(err.stderr !== undefined);
      assert.equal(err.name, 'TailscaleServeError');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// stopTailscaleServe — async I/O function (via _deps injection)
// ---------------------------------------------------------------------------

test('stopTailscaleServe with strict:true throws TailscaleServeError on failure', async () => {
  const fakeExecFile = ((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    const err = Object.assign(new Error('reset failed'), { code: 1, stderr: 'some error' });
    cb(err);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;

  await assert.rejects(
    () => withDepsAsync({ execFile: fakeExecFile }, () => stopTailscaleServe({ strict: true })),
    (err: unknown) => {
      assert.ok(err instanceof TailscaleServeError);
      return true;
    },
  );
});

test('stopTailscaleServe with strict:false swallows errors silently', async () => {
  const fakeExecFile = ((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    const err = Object.assign(new Error('reset failed'), { code: 1, stderr: 'some error' });
    cb(err);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;

  // Should not throw
  await withDepsAsync({ execFile: fakeExecFile }, () => stopTailscaleServe({ strict: false }));
});

test('stopTailscaleServe with no options swallows errors silently', async () => {
  const fakeExecFile = ((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    const err = Object.assign(new Error('reset failed'), { code: 1, stderr: 'some error' });
    cb(err);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;

  // Should not throw
  await withDepsAsync({ execFile: fakeExecFile }, () => stopTailscaleServe());
});

// ---------------------------------------------------------------------------
// stopTailscaleServeSync — sync I/O function (via _deps injection)
// ---------------------------------------------------------------------------

test('stopTailscaleServeSync never throws even when spawnSync fails', () => {
  withDeps(
    { spawnSync: (() => { throw new Error('tailscale not found'); }) as unknown as typeof spawnSync },
    () => stopTailscaleServeSync(),
  );
  // If we get here, no throw occurred
  assert.ok(true);
});

test('stopTailscaleServeSync never throws when spawnSync returns non-zero', () => {
  withDeps(
    { spawnSync: (() => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('error') })) as unknown as typeof spawnSync },
    () => stopTailscaleServeSync(),
  );
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// TailscaleServeError — class
// ---------------------------------------------------------------------------

test('TailscaleServeError preserves exitCode and stderr', () => {
  const err = new TailscaleServeError('serve failed', 2, 'daemon not running');
  assert.equal(err.exitCode, 2);
  assert.equal(err.stderr, 'daemon not running');
  assert.equal(err.name, 'TailscaleServeError');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof TailscaleServeError);
});

test('TailscaleServeError allows null exitCode', () => {
  const err = new TailscaleServeError('serve failed', null, '');
  assert.equal(err.exitCode, null);
});
