import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Derive a package root from an import.meta.url, returning null on failure.
 *
 * The Next.js standalone build bakes import.meta.url as the CI runner's
 * absolute path (e.g. file:///home/runner/work/gsd-2/gsd-2/src/web/bridge-service.ts).
 * On Windows, fileURLToPath() rejects this Linux path with
 * "File URL path must be absolute".
 *
 * This helper catches that error so the module-level constant never throws,
 * letting resolveBridgeRuntimeConfig() fall through to the GSD_WEB_PACKAGE_ROOT
 * env var that web-mode.ts always sets at launch time.
 *
 * @param importUrl - The value of import.meta.url at the call site.
 * @param ancestorLevels - How many directory levels to ascend from the module's
 *   directory to reach the package root (default 2: src/web/ -> root).
 * @returns Resolved absolute package root path, or null if the URL cannot be
 *   converted to a native path on this platform.
 */
export function safePackageRootFromImportUrl(
  importUrl: string,
  ancestorLevels = 2,
): string | null {
  try {
    const moduleDir = dirname(fileURLToPath(importUrl));
    const segments = Array.from({ length: ancestorLevels }, () => "..");
    return resolve(moduleDir, ...segments);
  } catch {
    return null;
  }
}
