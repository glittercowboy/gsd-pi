import { existsSync } from "node:fs";

function _require(name: string) {
  try {
    return require(name);
  } catch {
    try {
      const gsdPiRequire = require("module").createRequire(
        require("path").join(process.cwd(), "node_modules", "gsd-pi", "index.js")
      );
      return gsdPiRequire(name);
    } catch {
      return null;
    }
  }
}

export function withFileLockSync<T>(filePath: string, fn: () => T): T {
  const lockfile = _require("proper-lockfile");
  if (!lockfile) return fn();

  if (!existsSync(filePath)) return fn();

  try {
    const release = lockfile.lockSync(filePath, { retries: 5, stale: 10000 });
    try {
      return fn();
    } finally {
      release();
    }
  } catch (err: any) {
    if (err.code === "ELOCKED") {
      // Could not get lock after retries, let's fallback to un-locked instead of crashing the whole state machine
      return fn();
    }
    throw err;
  }
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T> | T): Promise<T> {
  const lockfile = _require("proper-lockfile");
  if (!lockfile) return await fn();

  if (!existsSync(filePath)) return await fn();

  try {
    const release = await lockfile.lock(filePath, { retries: 5, stale: 10000 });
    try {
      return await fn();
    } finally {
      await release();
    }
  } catch (err: any) {
    if (err.code === "ELOCKED") {
      return await fn();
    }
    throw err;
  }
}
