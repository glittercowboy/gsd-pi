import { describe, it } from 'node:test';

// TODO: Replace stubs with real assertions in Plan 04-02
describe('Tailscale setup assistant', () => {
  it.todo('should detect platform via process.platform');
  it.todo('should return brew install command for darwin');
  it.todo('should return curl script command for linux');
  it.todo('should return error for unsupported platform');
  it.todo('should parse auth URL from tailscale up stderr');
  it.todo('should report success when tailscale up exits 0');
  it.todo('should handle disconnect step running tailscale down');
});
