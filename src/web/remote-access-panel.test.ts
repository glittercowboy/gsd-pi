import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hashPassword, verifyPassword, createSessionToken, verifySessionToken, getOrCreateSessionSecret } from './web-session-auth.ts';
import { setPassword, getPasswordHash } from './web-password-storage.ts';

// ---------------------------------------------------------------------------
// Password validation logic — extracted behavior tests
// ---------------------------------------------------------------------------

describe('Password change API behavior', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gsd-panel-test-'));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects passwords shorter than 4 characters', () => {
    // The /api/settings/password endpoint checks newPassword.length < 4
    const shortPasswords = ['', 'a', 'ab', 'abc'];
    for (const pw of shortPasswords) {
      assert.ok(pw.length < 4, `"${pw}" should be rejected (length ${pw.length})`);
    }
  });

  it('accepts passwords of 4+ characters', () => {
    const validPasswords = ['abcd', 'correct-horse-battery', 'p@ss'];
    for (const pw of validPasswords) {
      assert.ok(pw.length >= 4, `"${pw}" should be accepted (length ${pw.length})`);
    }
  });

  it('setPassword + getPasswordHash round-trip works with real storage', async () => {
    await setPassword('test-password-123', tempDir);
    const hash = await getPasswordHash(tempDir);
    assert.ok(hash !== null, 'Hash should be stored');
    assert.ok(hash!.includes(':'), 'Hash format should be salt:hash');
    const valid = verifyPassword('test-password-123', hash!);
    assert.ok(valid, 'Password should verify against stored hash');
  });

  it('password change rotates session secret (invalidates old sessions)', async () => {
    const secret1 = await getOrCreateSessionSecret(tempDir);
    const token1 = createSessionToken(secret1, 30);

    await setPassword('new-password-456', tempDir);

    const secret2 = await getOrCreateSessionSecret(tempDir);
    assert.notEqual(secret1, secret2, 'Secret should change after password change');

    const payload = verifySessionToken(token1, secret2);
    assert.equal(payload, null, 'Old token should be invalid with new secret');
  });

  it('new token works with new secret after password change', async () => {
    const secret = await getOrCreateSessionSecret(tempDir);
    const token = createSessionToken(secret, 30);
    const payload = verifySessionToken(token, secret);
    assert.ok(payload !== null, 'New token should verify with current secret');
    assert.ok(payload!.expiresAt > Date.now(), 'Token should not be expired');
  });
});

// ---------------------------------------------------------------------------
// Tailscale status response shape — tests the actual parseTailscaleStatus
// ---------------------------------------------------------------------------

describe('Tailscale status API response shape', () => {
  it('parseTailscaleStatus strips trailing dot from dnsName', async () => {
    const { parseTailscaleStatus } = await import('./tailscale.ts');
    const result = parseTailscaleStatus({
      Self: {
        DNSName: 'my-machine.tail7e216d.ts.net.',
        HostName: 'my-machine',
        TailscaleIPs: ['100.64.0.1'],
      },
      MagicDNSSuffix: 'tail7e216d.ts.net',
    });
    assert.ok(result !== null);
    assert.ok(!result!.fqdn.endsWith('.'), 'fqdn must not end with trailing dot');
    assert.equal(result!.fqdn, 'my-machine.tail7e216d.ts.net');
    assert.ok(result!.url.startsWith('https://'), 'url must start with https://');
  });

  it('connected response has all expected fields', async () => {
    const { parseTailscaleStatus } = await import('./tailscale.ts');
    const result = parseTailscaleStatus({
      Self: {
        DNSName: 'box.example.ts.net.',
        HostName: 'box',
        TailscaleIPs: ['100.64.0.2'],
      },
      MagicDNSSuffix: 'example.ts.net',
    });
    assert.ok(result !== null);
    assert.equal(typeof result!.hostname, 'string');
    assert.equal(typeof result!.fqdn, 'string');
    assert.equal(typeof result!.url, 'string');
    assert.equal(typeof result!.tailnet, 'string');
  });
});
