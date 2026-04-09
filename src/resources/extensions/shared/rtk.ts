import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const GSD_RTK_PATH_ENV = "GSD_RTK_PATH";
const GSD_RTK_DISABLED_ENV = "GSD_RTK_DISABLED";
const GSD_RTK_REWRITE_TIMEOUT_MS_ENV = "GSD_RTK_REWRITE_TIMEOUT_MS";
const RTK_TELEMETRY_DISABLED_ENV = "RTK_TELEMETRY_DISABLED";
const RTK_REWRITE_TIMEOUT_MS = 5_000;

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getRewriteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env[GSD_RTK_REWRITE_TIMEOUT_MS_ENV] ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return RTK_REWRITE_TIMEOUT_MS;
}

export function isRtkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isTruthy(env[GSD_RTK_DISABLED_ENV]);
}

export function buildRtkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    [RTK_TELEMETRY_DISABLED_ENV]: "1",
  };
}

function getManagedRtkDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GSD_HOME || join(homedir(), ".gsd"), "agent", "bin");
}

function getRtkBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "rtk.exe" : "rtk";
}

function getPathValue(env: NodeJS.ProcessEnv): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? env[pathKey] : env.PATH;
}

function resolvePathCandidates(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveSystemRtkPath(pathValue: string | undefined, platform: NodeJS.Platform = process.platform): string | null {
  const candidates = platform === "win32"
    ? ["rtk.exe", "rtk.cmd", "rtk.bat", "rtk"]
    : ["rtk"];

  for (const dir of resolvePathCandidates(pathValue)) {
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

export interface ResolveRtkBinaryPathOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  platform?: NodeJS.Platform;
}

export function resolveRtkBinaryPath(options: ResolveRtkBinaryPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const explicitPath = options.binaryPath ?? env[GSD_RTK_PATH_ENV];
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const managedDir = getManagedRtkDir(env);
  const managedPath = join(managedDir, getRtkBinaryName(platform));
  if (existsSync(managedPath)) {
    return managedPath;
  }
  // On Windows, also check for rtk.cmd in the managed dir (used by test fake RTK
  // and any wrapper-style installs where a .cmd launcher accompanies the binary).
  if (platform === "win32") {
    const managedCmd = join(managedDir, "rtk.cmd");
    if (existsSync(managedCmd)) {
      return managedCmd;
    }
  }

  return resolveSystemRtkPath(options.pathValue ?? getPathValue(env), platform);
}

interface RewriteCommandOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  spawnSyncImpl?: typeof spawnSync;
}

export function rewriteCommandWithRtk(command: string, options: RewriteCommandOptions = {}): string {
  const env = options.env ?? process.env;

  if (!command.trim()) return command;
  if (!isRtkEnabled(env)) return command;

  const binaryPath = options.binaryPath ?? resolveRtkBinaryPath({ env });
  if (!binaryPath) return command;

  const run = options.spawnSyncImpl ?? spawnSync;
  const result = run(binaryPath, ["rewrite", command], {
    encoding: "utf-8",
    env: buildRtkEnv(env),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: getRewriteTimeoutMs(env),
    // .cmd/.bat wrappers (used by fake-rtk in tests) require shell:true on Windows
    shell: /\.(cmd|bat)$/i.test(binaryPath),
  });

  if (result.error) return command;
  if (result.status !== 0 && result.status !== 3) return command;

  const rewritten = (result.stdout ?? "").trimEnd();
  return rewritten || command;
}
