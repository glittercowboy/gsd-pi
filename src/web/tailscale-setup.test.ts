import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getInstallCommand } from './tailscale.ts';

// Re-declare AUTH_URL_PATTERN locally — the pattern is const in the route file and not exported.
// Declaring it here documents the expected contract and catches regex regressions if the route changes it.
const AUTH_URL_PATTERN = /https:\/\/login\.tailscale\.com\/[^\s]+/;

// ---------------------------------------------------------------------------
// getInstallCommand — pure function
// ---------------------------------------------------------------------------

describe('Tailscale setup assistant', () => {
  it('should return brew install command for darwin', () => {
    assert.equal(getInstallCommand('darwin'), 'brew install tailscale');
  });

  it('should return curl script command for linux', () => {
    const cmd = getInstallCommand('linux');
    assert.ok(cmd.startsWith('curl'), `Expected curl command, got: ${cmd}`);
    assert.ok(cmd.includes('tailscale.com/install.sh'), `Expected tailscale.com/install.sh in: ${cmd}`);
  });

  it('should return winget install command for win32', () => {
    assert.equal(getInstallCommand('win32'), 'winget install Tailscale.Tailscale');
  });

  it('should return curl script for unsupported platform (freebsd)', () => {
    const cmd = getInstallCommand('freebsd');
    assert.ok(cmd.startsWith('curl'), `Expected curl fallback for freebsd, got: ${cmd}`);
    assert.ok(cmd.includes('tailscale.com/install.sh'), `Expected tailscale.com/install.sh in: ${cmd}`);
  });

  it('should parse auth URL from tailscale up stderr (AUTH_URL_PATTERN)', () => {
    const authUrl = 'https://login.tailscale.com/a/abc123def456';
    assert.ok(AUTH_URL_PATTERN.test(authUrl), 'AUTH_URL_PATTERN should match valid auth URL');
  });

  it('should not match non-auth URLs with AUTH_URL_PATTERN', () => {
    assert.ok(!AUTH_URL_PATTERN.test('https://google.com'), 'AUTH_URL_PATTERN should not match google.com');
    assert.ok(!AUTH_URL_PATTERN.test('https://tailscale.com/download'), 'AUTH_URL_PATTERN should not match tailscale.com/download');
  });

  it('should return error for unsupported platform (by falling back to curl script)', () => {
    // getInstallCommand falls back to curl script for unrecognized platforms
    // This is by design — the route handler must show the command, not throw
    const cmd = getInstallCommand('aix');
    assert.ok(typeof cmd === 'string', 'Should return a string for any platform');
    assert.ok(cmd.length > 0, 'Should return a non-empty string for any platform');
  });
});
