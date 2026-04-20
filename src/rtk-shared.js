import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { delimiter, join } from "node:path";

export const GSD_RTK_DISABLED_ENV = "GSD_RTK_DISABLED";
export const GSD_RTK_PATH_ENV = "GSD_RTK_PATH";
export const RTK_TELEMETRY_DISABLED_ENV = "RTK_TELEMETRY_DISABLED";

export function isTruthy(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isRtkEnabled(env = process.env) {
  return !isTruthy(env[GSD_RTK_DISABLED_ENV]);
}

export function getManagedRtkDir(env = process.env) {
  return join(env.GSD_HOME || join(osHomedir(), ".gsd"), "agent", "bin");
}

export function getRtkBinaryName(platform = process.platform) {
  return platform === "win32" ? "rtk.exe" : "rtk";
}

export function getPathValue(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? env[pathKey] : env.PATH;
}

export function resolvePathCandidates(pathValue) {
  if (!pathValue) return [];
  return pathValue
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolveSystemRtkPath(pathValue, platform = process.platform) {
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
