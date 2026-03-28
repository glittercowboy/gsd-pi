import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TailscaleInfo {
  hostname: string;   // Self.HostName
  tailnet: string;    // MagicDNSSuffix
  fqdn: string;       // Self.DNSName with trailing dot stripped
  url: string;        // https://<fqdn>
}

export type TailscaleStatusResult =
  | { ok: true; info: TailscaleInfo }
  | { ok: false; reason: 'not-connected' | 'invalid-status' | 'cli-error'; stderr?: string };

export class TailscaleServeError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    exitCode: number | null,
    stderr: string,
  ) {
    super(message);
    this.name = 'TailscaleServeError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// Internal injectable deps (for testability without real tailscale)
// ---------------------------------------------------------------------------

type SpawnSyncFn = typeof spawnSync;
type ExecFileFn = typeof execFile;

interface TailscaleDeps {
  spawnSync: SpawnSyncFn;
  execFile: ExecFileFn;
}

// Mutable so tests can inject fakes
export const _deps: TailscaleDeps = {
  spawnSync,
  execFile,
};

// ---------------------------------------------------------------------------
// Pure functions (no I/O)
// ---------------------------------------------------------------------------

/**
 * Parse the output of `tailscale status --json` into a TailscaleInfo object.
 * Returns null if required fields are missing or invalid.
 */
export function parseTailscaleStatus(statusJson: unknown): TailscaleInfo | null {
  if (statusJson === null || typeof statusJson !== 'object') {
    return null;
  }
  const obj = statusJson as Record<string, unknown>;

  // Validate Self field
  if (!obj['Self'] || typeof obj['Self'] !== 'object') {
    return null;
  }
  const self = obj['Self'] as Record<string, unknown>;

  // Validate required Self subfields
  if (typeof self['DNSName'] !== 'string') {
    return null;
  }
  if (typeof self['HostName'] !== 'string') {
    return null;
  }

  // Validate MagicDNSSuffix
  if (typeof obj['MagicDNSSuffix'] !== 'string') {
    return null;
  }

  const hostname = self['HostName'];
  const tailnet = obj['MagicDNSSuffix'];
  const fqdn = self['DNSName'].replace(/\.$/, '');
  const url = `https://${fqdn}`;

  return { hostname, tailnet, fqdn, url };
}

/**
 * Returns the args array for `tailscale serve --bg` for the given local port.
 * Example: buildServeCommand(3456) → ["serve", "--bg", "--https", "443", "http://127.0.0.1:3456"]
 */
export function buildServeCommand(localPort: number): string[] {
  return ['serve', '--bg', '--https', '443', `http://127.0.0.1:${localPort}`];
}

/**
 * Returns the args array for `tailscale serve reset`.
 */
export function buildServeResetCommand(): string[] {
  return ['serve', 'reset'];
}

/**
 * Returns the platform-appropriate install command for Tailscale.
 * This is a display-only hint — not executed by the system.
 */
export function getInstallCommand(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'brew install tailscale';
  }
  if (platform === 'win32') {
    return 'winget install Tailscale.Tailscale';
  }
  return 'curl -fsSL https://tailscale.com/install.sh | sh';
}

// ---------------------------------------------------------------------------
// I/O functions
// ---------------------------------------------------------------------------

/**
 * Check whether the `tailscale` CLI is on PATH by running `tailscale version`.
 * Synchronous — suitable for preflight checks before server startup.
 */
export function isTailscaleInstalled(): boolean {
  try {
    const result = _deps.spawnSync('tailscale', ['version'], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Query `tailscale status --json` and return a discriminated result.
 * Synchronous — suitable for preflight checks before server startup.
 *
 * Returns:
 * - { ok: true, info } on success
 * - { ok: false, reason: 'not-connected' } on non-zero exit (daemon not running or not connected)
 * - { ok: false, reason: 'invalid-status' } on JSON parse failure or missing fields
 * - { ok: false, reason: 'cli-error', stderr } on unexpected exception
 */
export function getTailscaleStatus(): TailscaleStatusResult {
  try {
    const result = _deps.spawnSync('tailscale', ['status', '--json'], { stdio: 'pipe' });
    if (result.status !== 0) {
      return { ok: false, reason: 'not-connected' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString('utf8'));
    } catch {
      return { ok: false, reason: 'invalid-status' };
    }

    const info = parseTailscaleStatus(parsed);
    if (info === null) {
      return { ok: false, reason: 'invalid-status' };
    }

    return { ok: true, info };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'cli-error', stderr: message };
  }
}

/**
 * Start `tailscale serve --bg` to expose the given local port via Tailscale HTTPS.
 * Async — runs during server startup after the Next.js server is boot-ready.
 *
 * Throws TailscaleServeError on failure, preserving exitCode and stderr.
 */
export async function startTailscaleServe(localPort: number): Promise<void> {
  const execFileAsync = promisify(_deps.execFile);
  try {
    await execFileAsync('tailscale', buildServeCommand(localPort));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number; stderr?: string };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    const stderr = e.stderr ?? e.message ?? String(err);
    throw new TailscaleServeError(
      `tailscale serve failed: ${e.message}`,
      exitCode,
      stderr,
    );
  }
}

/**
 * Run `tailscale serve reset` to remove all serve configuration.
 * Async — used during server startup (strict mode) and shutdown (lenient mode).
 *
 * Options:
 * - strict: true  → throws TailscaleServeError on failure (use for startup reset where failure is actionable)
 * - strict: false (default) → swallows errors silently (use for shutdown cleanup where best-effort is fine)
 */
export async function stopTailscaleServe(options?: { strict?: boolean }): Promise<void> {
  const execFileAsync = promisify(_deps.execFile);
  try {
    await execFileAsync('tailscale', buildServeResetCommand());
  } catch (err) {
    if (options?.strict) {
      const e = err as NodeJS.ErrnoException & { code?: number; stderr?: string };
      const exitCode = typeof e.code === 'number' ? e.code : null;
      const stderr = e.stderr ?? e.message ?? String(err);
      throw new TailscaleServeError(
        `tailscale serve reset failed: ${(err as Error).message}`,
        exitCode,
        stderr,
      );
    }
    // Lenient mode — swallow error silently
  }
}

/**
 * Synchronous variant of stopTailscaleServe for use in `process.on('exit')` handlers,
 * where async code cannot run.
 * Never throws — any failure is silently ignored.
 */
export function stopTailscaleServeSync(): void {
  try {
    _deps.spawnSync('tailscale', buildServeResetCommand(), { stdio: 'pipe' });
  } catch {
    // Never throws — best-effort cleanup for exit handlers
  }
}
