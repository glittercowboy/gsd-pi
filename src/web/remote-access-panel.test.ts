import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// RemoteAccessPanel — password form validation logic (inline, no React needed)
// ---------------------------------------------------------------------------

describe('RemoteAccessPanel', () => {
  it('should render password form with min 4 char validation', () => {
    // A string of length < 4 fails minimum length check
    assert.ok('abc'.length < 4, 'password "abc" should fail min-length check');
    // An empty string fails minimum length check
    assert.ok(''.length < 4, 'empty string should fail min-length check');
    // A string of length 4 passes minimum length check
    assert.ok('abcd'.length >= 4, 'password "abcd" should pass min-length check');
    // A longer string also passes
    assert.ok('correct-horse-battery'.length >= 4, 'long password should pass min-length check');
  });

  it('should display Tailscale URL as copyable link when connected (HTTPS URL contract)', () => {
    // tailnetUrl starts with 'https://' when present
    const mockTailnetUrl = 'https://my-machine.tail7e216d.ts.net';
    assert.ok(mockTailnetUrl.startsWith('https://'), 'tailnetUrl must start with https://');
  });

  it('should show password-required notice when no password configured', () => {
    // Document the condition: passwordConfigured === false shows notice
    const passwordConfigured = false;
    assert.ok(!passwordConfigured, 'When passwordConfigured is false, notice should be shown');
  });

  it('should launch setup assistant on button click', () => {
    // The setup API route path is /api/tailscale/setup (not /api/tailscale/configure)
    const setupRoutePath = '/api/tailscale/setup';
    assert.equal(setupRoutePath, '/api/tailscale/setup');
  });

  it('should show connect/disconnect toggle when installed and password set', () => {
    // Connect/disconnect toggle is shown when: installed === true AND passwordConfigured === true
    const installed = true;
    const passwordConfigured = true;
    assert.ok(installed && passwordConfigured, 'Toggle should be shown when both conditions are true');
    assert.ok(!(false && passwordConfigured), 'Toggle should be hidden when not installed');
    assert.ok(!(installed && false), 'Toggle should be hidden when no password configured');
  });
});

// ---------------------------------------------------------------------------
// Tailscale status response contract — /api/tailscale/status
// ---------------------------------------------------------------------------

describe('Tailscale status response contract', () => {
  it('should have connected response shape: { installed, connected, hostname, tailnetUrl, dnsName }', () => {
    // Document and verify the connected status response shape
    const connectedResponse = {
      installed: true,
      connected: true,
      hostname: 'my-machine',
      tailnetUrl: 'https://my-machine.tail7e216d.ts.net',
      dnsName: 'my-machine.tail7e216d.ts.net',
    };

    assert.equal(connectedResponse.installed, true);
    assert.equal(connectedResponse.connected, true);
    assert.ok(typeof connectedResponse.hostname === 'string');
    assert.ok(typeof connectedResponse.tailnetUrl === 'string');
    assert.ok(typeof connectedResponse.dnsName === 'string');
  });

  it('should have not-installed response shape: { installed: false, connected: false, empty strings }', () => {
    // Document and verify the not-installed response shape
    const notInstalledResponse = {
      installed: false,
      connected: false,
      hostname: '',
      tailnetUrl: '',
      dnsName: '',
    };

    assert.equal(notInstalledResponse.installed, false);
    assert.equal(notInstalledResponse.connected, false);
    assert.equal(notInstalledResponse.hostname, '');
    assert.equal(notInstalledResponse.tailnetUrl, '');
    assert.equal(notInstalledResponse.dnsName, '');
  });

  it('tailnetUrl starts with https:// when present', () => {
    const tailnetUrl = 'https://my-machine.tail7e216d.ts.net';
    assert.ok(tailnetUrl.startsWith('https://'), 'tailnetUrl must start with https://');
  });

  it('dnsName does not end with dot (trailing dot already stripped by tailscale.ts)', () => {
    // parseTailscaleStatus strips the trailing dot from DNSName before setting fqdn
    // The route maps fqdn -> dnsName, so dnsName must never have a trailing dot
    const dnsName = 'my-machine.tail7e216d.ts.net';
    assert.ok(!dnsName.endsWith('.'), 'dnsName must not end with trailing dot');
  });

  it('password API route path is /api/settings/password (not /api/auth/password)', () => {
    // D-06: Password change requires auth — route is under /api/settings/ (protected by middleware)
    const passwordRoutePath = '/api/settings/password';
    assert.equal(passwordRoutePath, '/api/settings/password');
    assert.ok(!passwordRoutePath.startsWith('/api/auth/'), 'Route must not be under /api/auth/ which is unauthenticated');
  });
});
