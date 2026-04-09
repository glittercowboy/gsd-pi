import { writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';

// --------------- types ---------------

export interface PlistOptions {
  /** Absolute path to the Node.js binary */
  nodePath: string;
  /** Absolute path to the daemon script (cli.js) */
  scriptPath: string;
  /** Absolute path to the config file */
  configPath: string;
  /** Directory to use as WorkingDirectory in the plist (defaults to homedir) */
  workingDirectory?: string;
  /** Override stdout log path */
  stdoutPath?: string;
  /** Override stderr log path */
  stderrPath?: string;
}

export interface LaunchdStatus {
  /** Whether the daemon is registered with launchd */
  registered: boolean;
  /** PID if currently running, null otherwise */
  pid: number | null;
  /** Last exit status code, null if never exited or not available */
  lastExitStatus: number | null;
}

export type RunCommandFn = (cmd: string) => string;

// --------------- constants ---------------

const LABEL = 'com.gsd.daemon';
const PLIST_FILENAME = `${LABEL}.plist`;

// --------------- helpers ---------------

/** Escape special XML characters in a string. */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Return the canonical plist path under ~/Library/LaunchAgents/. */
export function getPlistPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', PLIST_FILENAME);
}

/**
 * Build the NVM-aware PATH string.
 * Includes the directory containing the Node binary so that launchd can find node
 * even when launched outside a shell session (where NVM isn't sourced).
 */
function buildEnvPath(nodePath: string): string {
  const nodeBinDir = dirname(nodePath);
  // Keep system essentials and prepend the node binary's directory
  return `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
}

// --------------- plist generation ---------------

/** Generate valid launchd plist XML for the GSD daemon. */
export function generatePlist(opts: PlistOptions): string {
  const home = homedir();
  const workDir = opts.workingDirectory ?? home;
  const stdoutPath = opts.stdoutPath ?? resolve(home, '.gsd', 'daemon-stdout.log');
  const stderrPath = opts.stderrPath ?? resolve(home, '.gsd', 'daemon-stderr.log');
  const envPath = buildEnvPath(opts.nodePath);

  // Forward ANTHROPIC_API_KEY so the orchestrator LLM can authenticate.
  // Captured at install time from the current process environment.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicKeyXml = anthropicKey
    ? `\n\t\t<key>ANTHROPIC_API_KEY</key>\n\t\t<string>${escapeXml(anthropicKey)}</string>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(LABEL)}</string>

\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(opts.nodePath)}</string>
\t\t<string>${escapeXml(opts.scriptPath)}</string>
\t\t<string>--config</string>
\t\t<string>${escapeXml(opts.configPath)}</string>
\t</array>

\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>

\t<key>RunAtLoad</key>
\t<true/>

\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(envPath)}</string>
\t\t<key>HOME</key>
\t\t<string>${escapeXml(home)}</string>${anthropicKeyXml}
\t</dict>

\t<key>WorkingDirectory</key>
\t<string>${escapeXml(workDir)}</string>

\t<key>StandardOutPath</key>
\t<string>${escapeXml(stdoutPath)}</string>

\t<key>StandardErrorPath</key>
\t<string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

// --------------- install / uninstall / status ---------------

/** Default runCommand using execSync. */
function defaultRunCommand(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Install the launchd agent: write plist and load it.
 * Idempotent — unloads first if already loaded.
 */
export function install(
  opts: PlistOptions,
  runCommand: RunCommandFn = defaultRunCommand,
): void {
  const plistPath = getPlistPath();
  const xml = generatePlist(opts);

  // Unload first if already present (ignore errors)
  if (existsSync(plistPath)) {
    try {
      runCommand(`launchctl unload ${plistPath}`);
    } catch {
      // already unloaded — fine
    }
  }

  writeFileSync(plistPath, xml, 'utf-8');
  chmodSync(plistPath, 0o644);

  runCommand(`launchctl load ${plistPath}`);

  // Verify it loaded
  try {
    runCommand(`launchctl list ${LABEL}`);
  } catch {
    throw new Error(
      `Plist was written to ${plistPath} and launchctl load succeeded, but launchctl list ${LABEL} failed. The agent may not have started.`,
    );
  }
}

/**
 * Uninstall the launchd agent: unload and remove plist.
 * Graceful — does not throw if already uninstalled.
 */
export function uninstall(runCommand: RunCommandFn = defaultRunCommand): void {
  const plistPath = getPlistPath();

  if (existsSync(plistPath)) {
    try {
      runCommand(`launchctl unload ${plistPath}`);
    } catch {
      // already unloaded — that's fine
    }
    unlinkSync(plistPath);
  }
  // If plist doesn't exist, nothing to do — already uninstalled
}

/**
 * Query launchd for the daemon's status.
 * Returns structured information about registration, PID, and last exit code.
 *
 * Handles two launchctl output formats:
 * 1. Tabular: "PID\tStatus\tLabel" (older macOS)
 * 2. JSON-style dict: `"PID" = 1234;` / `"LastExitStatus" = 0;` (newer macOS)
 */
export function status(runCommand: RunCommandFn = defaultRunCommand): LaunchdStatus {
  try {
    const output = runCommand(`launchctl list ${LABEL}`);

    // --- Try tabular format first ---
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\t+/);
      if (parts.length >= 3 && parts[2] === LABEL) {
        const pidStr = parts[0];
        const statusStr = parts[1];

        const pid = pidStr === '-' ? null : parseInt(pidStr, 10);
        const lastExitStatus = statusStr != null ? parseInt(statusStr, 10) : null;

        return {
          registered: true,
          pid: Number.isNaN(pid!) ? null : pid,
          lastExitStatus: Number.isNaN(lastExitStatus!) ? null : lastExitStatus,
        };
      }
    }

    // --- Try JSON-style dict format ---
    // Matches: "PID" = 1234;  or  "LastExitStatus" = 0;
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)\s*;/);
    const exitMatch = output.match(/"LastExitStatus"\s*=\s*(\d+)\s*;/);

    if (pidMatch || exitMatch) {
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
      const lastExitStatus = exitMatch ? parseInt(exitMatch[1], 10) : null;
      return {
        registered: true,
        pid: Number.isNaN(pid!) ? null : pid,
        lastExitStatus: Number.isNaN(lastExitStatus!) ? null : lastExitStatus,
      };
    }

    // Label resolved (no error) but no parseable output — still registered
    return { registered: true, pid: null, lastExitStatus: null };
  } catch {
    // launchctl list exits non-zero when the label isn't found
    return { registered: false, pid: null, lastExitStatus: null };
  }
}
