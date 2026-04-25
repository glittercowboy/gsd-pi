import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rel = relative(rootRealPath, candidateRealPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate and resolve a requested path against the given root directory.
 * Returns the resolved absolute path or null if the path is invalid.
 */
export function resolveSecurePath(requestedPath: string, root: string, options: { mustExist?: boolean } = {}): string | null {
  if (requestedPath.startsWith("/") || requestedPath.startsWith("\\")) {
    return null;
  }
  if (requestedPath.includes("..")) {
    return null;
  }

  let rootRealPath: string;
  try {
    rootRealPath = realpathSync.native(root);
  } catch {
    return null;
  }

  const resolved = resolve(rootRealPath, requestedPath);
  const rel = relative(rootRealPath, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }

  try {
    if (existsSync(resolved)) {
      const targetRealPath = realpathSync.native(resolved);
      if (!isWithinRoot(rootRealPath, targetRealPath)) return null;
    } else {
      if (options.mustExist) return null;
      const parentRealPath = realpathSync.native(dirname(resolved));
      if (!isWithinRoot(rootRealPath, parentRealPath)) return null;
    }
  } catch {
    return null;
  }

  return resolved;
}
