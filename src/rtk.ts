import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { arch as osArch } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import extractZip from "extract-zip";
import {
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  RTK_TELEMETRY_DISABLED_ENV,
  getManagedRtkDir,
  getPathValue,
  getRtkBinaryName,
  isTruthy,
  isRtkEnabled,
  resolveSystemRtkPath,
} from "./rtk-shared.js";

export const RTK_VERSION = "0.33.1";
export const GSD_SKIP_RTK_INSTALL_ENV = "GSD_SKIP_RTK_INSTALL";
export {
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  RTK_TELEMETRY_DISABLED_ENV,
  getManagedRtkDir,
  getRtkBinaryName,
  isRtkEnabled,
};

const RTK_REPO = "rtk-ai/rtk";
const RTK_REWRITE_TIMEOUT_MS = 5_000;

export interface EnsureRtkOptions {
  targetDir?: string;
  allowDownload?: boolean;
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  releaseVersion?: string;
  log?: (message: string) => void;
}

export interface EnsureRtkResult {
  enabled: boolean;
  supported: boolean;
  available: boolean;
  source: "disabled" | "unsupported" | "managed" | "system" | "downloaded" | "missing";
  binaryPath?: string;
  reason?: string;
}

export function getManagedRtkPath(
  platform: NodeJS.Platform = process.platform,
  targetDir: string = getManagedRtkDir(),
): string {
  return join(targetDir, getRtkBinaryName(platform));
}

export function prependPathEntry(env: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? (process.platform === "win32" ? "Path" : "PATH");
  const currentPath = env[pathKey] ?? "";
  const parts = currentPath.split(delimiter).filter(Boolean);
  if (!parts.includes(entry)) {
    env[pathKey] = [entry, currentPath].filter(Boolean).join(delimiter);
  }
  return env;
}

export function applyRtkProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  prependPathEntry(env, getManagedRtkDir(env));
  env[RTK_TELEMETRY_DISABLED_ENV] = "1";
  return env;
}

export function buildRtkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return applyRtkProcessEnv({ ...env });
}

export function resolveRtkAssetName(
  platform: NodeJS.Platform,
  arch: string,
  version: string = RTK_VERSION,
): string | null {
  void version;
  if (platform === "darwin" && arch === "arm64") return "rtk-aarch64-apple-darwin.tar.gz";
  if (platform === "darwin" && arch === "x64") return "rtk-x86_64-apple-darwin.tar.gz";
  if (platform === "linux" && arch === "arm64") return "rtk-aarch64-unknown-linux-gnu.tar.gz";
  if (platform === "linux" && arch === "x64") return "rtk-x86_64-unknown-linux-musl.tar.gz";
  if (platform === "win32" && arch === "x64") return "rtk-x86_64-pc-windows-msvc.zip";
  return null;
}

function getReleaseBaseUrl(version: string): string {
  return `https://github.com/${RTK_REPO}/releases/download/v${version}`;
}

function getChecksumsUrl(version: string): string {
  return `${getReleaseBaseUrl(version)}/checksums.txt`;
}

function buildAssetUrl(version: string, assetName: string): string {
  return `${getReleaseBaseUrl(version)}/${assetName}`;
}

function parseChecksums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) continue;
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "gsd-pi-rtk" },
  });

  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  if (!response.body) {
    throw new Error(`download returned no body for ${url}`);
  }

  const output = createWriteStream(destination);
  await finished(Readable.fromWeb(response.body as never).pipe(output));
}

function findBinaryRecursively(rootDir: string, binaryName: string): string | null {
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && entry.name === binaryName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return null;
}

function extractArchive(assetName: string, archivePath: string, extractDir: string): void {
  if (!assetName.endsWith(".tar.gz")) {
    throw new Error(`unsupported RTK archive format: ${assetName}`);
  }

  mkdirSync(extractDir, { recursive: true });
  const result = spawnSync("tar", ["xzf", archivePath, "-C", extractDir], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr?.trim() ?? `tar extraction failed for ${assetName}`);
  }
}

async function extractArchiveAsync(assetName: string, archivePath: string, extractDir: string): Promise<void> {
  if (assetName.endsWith(".zip")) {
    mkdirSync(extractDir, { recursive: true });
    await extractZip(archivePath, { dir: extractDir });
    return;
  }
  extractArchive(assetName, archivePath, extractDir);
}


export interface ResolveRtkBinaryPathOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  platform?: NodeJS.Platform;
  targetDir?: string;
}

export function resolveRtkBinaryPath(options: ResolveRtkBinaryPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (options.binaryPath) return options.binaryPath;
  const explicitPath = env[GSD_RTK_PATH_ENV];
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const managedPath = getManagedRtkPath(platform, options.targetDir ?? getManagedRtkDir(env));
  if (existsSync(managedPath)) {
    return managedPath;
  }
  // On Windows, also check for rtk.cmd in the managed dir (used by test fake RTK
  // and any wrapper-style installs where a .cmd launcher accompanies the binary).
  if (platform === "win32") {
    const managedDir = options.targetDir ?? getManagedRtkDir(env);
    const managedCmd = join(managedDir, "rtk.cmd");
    if (existsSync(managedCmd)) {
      return managedCmd;
    }
  }

  return resolveSystemRtkPath(options.pathValue ?? getPathValue(env), platform);
}

export interface RewriteCommandOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnSyncImpl?: typeof spawnSync;
}

export function rewriteCommandWithRtk(command: string, options: RewriteCommandOptions = {}): string {
  if (!command.trim()) return command;
  if (!isRtkEnabled(options.env ?? process.env)) return command;

  const env = options.env ?? process.env;
  const binaryPath = resolveRtkBinaryPath({
    env,
    binaryPath: options.binaryPath,
  });

  if (!binaryPath) return command;

  const run = options.spawnSyncImpl ?? spawnSync;
  const result = run(binaryPath, ["rewrite", command], {
    encoding: "utf-8",
    env: buildRtkEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs ?? RTK_REWRITE_TIMEOUT_MS,
    // .cmd/.bat wrappers (used by fake-rtk in tests) require shell:true on Windows
    shell: /\.(cmd|bat)$/i.test(binaryPath),
  });

  if (result.error) return command;
  if (result.status !== 0 && result.status !== 3) return command;

  const rewritten = (result.stdout ?? "").trimEnd();
  return rewritten || command;
}

export interface ValidateRtkBinaryOptions {
  spawnSyncImpl?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
}

export function validateRtkBinary(binaryPath: string, options: ValidateRtkBinaryOptions = {}): boolean {
  const run = options.spawnSyncImpl ?? spawnSync;
  const result = run(binaryPath, ["rewrite", "git status"], {
    encoding: "utf-8",
    env: buildRtkEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: RTK_REWRITE_TIMEOUT_MS,
  });

  if (result.error) return false;
  if (result.status !== 0) return false;
  return (result.stdout ?? "").trim() === "rtk git status";
}

export async function ensureRtkAvailable(options: EnsureRtkOptions = {}): Promise<EnsureRtkResult> {
  const env = options.env ?? process.env;
  if (!isRtkEnabled(env)) {
    return { enabled: false, supported: true, available: false, source: "disabled", reason: `${GSD_RTK_DISABLED_ENV} is set` };
  }
  if (isTruthy(env[GSD_SKIP_RTK_INSTALL_ENV])) {
    const configuredPath = env[GSD_RTK_PATH_ENV];
    if (configuredPath && existsSync(configuredPath)) {
      return { enabled: true, supported: true, available: true, source: "managed", binaryPath: configuredPath };
    }
    return { enabled: true, supported: true, available: false, source: "missing", reason: `${GSD_SKIP_RTK_INSTALL_ENV} is set` };
  }

  const targetDir = options.targetDir ?? getManagedRtkDir(env);
  const managedPath = getManagedRtkPath(process.platform, targetDir);

  if (existsSync(managedPath) && validateRtkBinary(managedPath, { env })) {
    return { enabled: true, supported: true, available: true, source: "managed", binaryPath: managedPath };
  }

  const systemPath = resolveSystemRtkPath(options.pathValue ?? getPathValue(env));
  if (systemPath && validateRtkBinary(systemPath, { env })) {
    return { enabled: true, supported: true, available: true, source: "system", binaryPath: systemPath };
  }

  const version = options.releaseVersion ?? RTK_VERSION;
  const assetName = resolveRtkAssetName(process.platform, osArch(), version);
  if (!assetName) {
    return {
      enabled: true,
      supported: false,
      available: false,
      source: "unsupported",
      reason: `RTK release asset unavailable for ${process.platform}/${osArch()}`,
    };
  }

  if (options.allowDownload === false) {
    return { enabled: true, supported: true, available: false, source: "missing", reason: "download disabled" };
  }

  mkdirSync(targetDir, { recursive: true });

  const tempRoot = join(targetDir, `.rtk-install-${randomUUID().slice(0, 8)}`);
  const archivePath = join(tempRoot, assetName);
  const extractDir = join(tempRoot, "extract");

  mkdirSync(tempRoot, { recursive: true });

  try {
    const checksumsUrl = getChecksumsUrl(version);
    const checksumsResponse = await fetch(checksumsUrl, { headers: { "User-Agent": "gsd-pi-rtk" } });
    if (!checksumsResponse.ok) {
      throw new Error(`failed to fetch RTK checksums (${checksumsResponse.status})`);
    }
    const checksums = parseChecksums(await checksumsResponse.text());
    const expectedSha = checksums.get(assetName);
    if (!expectedSha) {
      throw new Error(`missing checksum for ${assetName}`);
    }

    await downloadToFile(buildAssetUrl(version, assetName), archivePath);
    const actualSha = sha256File(archivePath);
    if (actualSha !== expectedSha) {
      throw new Error(`checksum mismatch for ${assetName}`);
    }

    await extractArchiveAsync(assetName, archivePath, extractDir);
    const extractedBinary = findBinaryRecursively(extractDir, getRtkBinaryName(process.platform));
    if (!extractedBinary) {
      throw new Error(`RTK binary not found in ${assetName}`);
    }

    copyFileSync(extractedBinary, managedPath);
    if (process.platform !== "win32") {
      chmodSync(managedPath, 0o755);
    }

    if (!validateRtkBinary(managedPath, { env })) {
      rmSync(managedPath, { force: true });
      throw new Error("downloaded RTK binary failed validation");
    }

    options.log?.(`installed RTK ${version} to ${managedPath}`);
    return { enabled: true, supported: true, available: true, source: "downloaded", binaryPath: managedPath };
  } catch (error) {
    options.log?.(`RTK install skipped: ${error instanceof Error ? error.message : String(error)}`);
    return {
      enabled: true,
      supported: true,
      available: false,
      source: "missing",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function bootstrapRtk(options: EnsureRtkOptions = {}): Promise<EnsureRtkResult> {
  const result = await ensureRtkAvailable(options);
  applyRtkProcessEnv(process.env);
  if (result.binaryPath) {
    process.env[GSD_RTK_PATH_ENV] = result.binaryPath;
  }
  return result;
}
