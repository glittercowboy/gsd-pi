import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DaemonConfig, LogLevel } from './types.js';

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);

/** Expand leading ~ to the user's home directory. */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2) || '.');
  }
  return p;
}

/** Default config values when no file is present or fields are missing. */
function defaults(): DaemonConfig {
  return {
    discord: undefined,
    projects: { scan_roots: [] },
    log: {
      file: resolve(homedir(), '.gsd', 'daemon.log'),
      level: 'info',
      max_size_mb: 50,
    },
  };
}

/**
 * Resolve the config file path.
 * Priority: explicit CLI arg → GSD_DAEMON_CONFIG env → ~/.gsd/daemon.yaml
 */
export function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return expandTilde(cliPath);
  const envPath = process.env['GSD_DAEMON_CONFIG'];
  if (envPath) return expandTilde(envPath);
  return resolve(homedir(), '.gsd', 'daemon.yaml');
}

/**
 * Validate and normalise a raw parsed object into a DaemonConfig.
 * Missing/invalid fields are filled with defaults. Invalid log level falls back to 'info'.
 */
export function validateConfig(raw: unknown): DaemonConfig {
  const def = defaults();

  if (raw == null || typeof raw !== 'object') return def;
  const obj = raw as Record<string, unknown>;

  // --- discord ---
  let discord: DaemonConfig['discord'] = undefined;
  if (obj['discord'] != null && typeof obj['discord'] === 'object') {
    const d = obj['discord'] as Record<string, unknown>;
    discord = {
      token: typeof d['token'] === 'string' ? d['token'] : '',
      guild_id: typeof d['guild_id'] === 'string' ? d['guild_id'] : '',
      owner_id: typeof d['owner_id'] === 'string' ? d['owner_id'] : '',
      ...(typeof d['dm_on_blocker'] === 'boolean' ? { dm_on_blocker: d['dm_on_blocker'] } : {}),
      ...(typeof d['control_channel_id'] === 'string' ? { control_channel_id: d['control_channel_id'] } : {}),
    };

    // Parse orchestrator sub-block
    if (d['orchestrator'] != null && typeof d['orchestrator'] === 'object') {
      const orc = d['orchestrator'] as Record<string, unknown>;
      discord.orchestrator = {
        ...(typeof orc['model'] === 'string' ? { model: orc['model'] } : {}),
        ...(typeof orc['max_tokens'] === 'number' && orc['max_tokens'] > 0 ? { max_tokens: orc['max_tokens'] } : {}),
      };
    }
  }

  // --- projects ---
  let scanRoots: string[] = [];
  if (obj['projects'] != null && typeof obj['projects'] === 'object') {
    const p = obj['projects'] as Record<string, unknown>;
    if (Array.isArray(p['scan_roots'])) {
      scanRoots = (p['scan_roots'] as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .map(expandTilde);
    }
  }

  // --- log ---
  let logFile = def.log.file;
  let logLevel: LogLevel = def.log.level;
  let maxSizeMb = def.log.max_size_mb;

  if (obj['log'] != null && typeof obj['log'] === 'object') {
    const l = obj['log'] as Record<string, unknown>;
    if (typeof l['file'] === 'string') logFile = expandTilde(l['file']);
    if (typeof l['level'] === 'string') {
      logLevel = VALID_LOG_LEVELS.has(l['level']) ? (l['level'] as LogLevel) : 'info';
    }
    if (typeof l['max_size_mb'] === 'number' && l['max_size_mb'] > 0) {
      maxSizeMb = l['max_size_mb'];
    }
  }

  // --- env override: DISCORD_BOT_TOKEN ---
  const envToken = process.env['DISCORD_BOT_TOKEN'];
  if (envToken) {
    if (!discord) {
      discord = { token: envToken, guild_id: '', owner_id: '' };
    } else {
      discord = { ...discord, token: envToken };
    }
  }

  return {
    discord,
    projects: { scan_roots: scanRoots },
    log: { file: logFile, level: logLevel, max_size_mb: maxSizeMb },
  };
}

/**
 * Load and validate a DaemonConfig from a YAML file.
 * If the file doesn't exist, returns defaults. If the file is malformed YAML, throws.
 */
export function loadConfig(configPath: string): DaemonConfig {
  if (!existsSync(configPath)) {
    // Still apply env-var overrides even when file is missing
    return validateConfig(null);
  }

  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML config at ${configPath}: ${msg}`);
  }

  return validateConfig(parsed);
}
