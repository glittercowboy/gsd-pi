import { describe, it } from 'node:test';

// TODO: Replace stubs with real assertions in Plan 04-01
describe('Password change API (/api/settings/password)', () => {
  it.todo('should hash and store new password via setPassword()');
  it.todo('should reject passwords shorter than 4 chars with 400');
  it.todo('should rotate session secret after password change');
  it.todo('should re-issue session cookie for current browser (D-07)');
});

describe('Tailscale status API (/api/tailscale/status)', () => {
  it.todo('should return connected status with hostname and URL');
  it.todo('should return connected: false when Tailscale is not running');
  it.todo('should return installed: false when Tailscale CLI is missing');
});
