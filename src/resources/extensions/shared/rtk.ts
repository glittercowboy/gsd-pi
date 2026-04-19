import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  RTK_TELEMETRY_DISABLED_ENV,
  getManagedRtkDir,
  getPathValue,
  getRtkBinaryName,
  isRtkEnabled,
  resolveSystemRtkPath,
} from "./rtk-shared.js";

const GSD_RTK_REWRITE_TIMEOUT_MS_ENV = "GSD_RTK_REWRITE_TIMEOUT_MS";
const RTK_REWRITE_TIMEOUT_MS = 5_000;

export { isRtkEnabled };

function getRewriteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env[GSD_RTK_REWRITE_TIMEOUT_MS_ENV] ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return RTK_REWRITE_TIMEOUT_MS;
}

export function buildRtkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    [RTK_TELEMETRY_DISABLED_ENV]: "1",
  };
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
