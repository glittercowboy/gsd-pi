import { existsSync as fsExistsSync } from "node:fs"
import { join } from "node:path"

/**
 * Returns the correct Node.js type-stripping flag for subprocess spawning.
 *
 * Node v24 enforces ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING for files
 * resolved under `node_modules/`. When GSD is installed globally via npm,
 * all source files live under `node_modules/gsd-pi/src/...`, so
 * `--experimental-strip-types` fails deterministically.
 *
 * `--experimental-transform-types` applies a full TypeScript transform that
 * bypasses the restriction on older Node versions (22.7–23.x). On Node v24+
 * where type stripping is stable, the restriction is absolute — use
 * {@link resolveSubprocessModule} to resolve to compiled .js instead.
 */
export function resolveTypeStrippingFlag(packageRoot: string): string {
  const needsTransform =
    isUnderNodeModules(packageRoot) && supportsTransformTypes()
  return needsTransform
    ? "--experimental-transform-types"
    : "--experimental-strip-types"
}

export interface ResolveSubprocessModuleOptions {
  existsSync?: (path: string) => boolean
}

/**
 * Resolves a subprocess module path, preferring the compiled .js equivalent
 * under `dist/` when the package is installed inside `node_modules/`.
 *
 * Node v24 unconditionally refuses to handle .ts files under `node_modules/`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), even with
 * `--experimental-transform-types`. When GSD is installed globally via npm
 * the source .ts files live under `node_modules/gsd-pi/src/...`, so
 * subprocess invocations must use the compiled output in `dist/` instead.
 *
 * @param packageRoot - Absolute path to the package root directory.
 * @param relPath     - Path relative to `src/` (e.g. "resources/extensions/gsd/auto.ts").
 * @param options     - Optional overrides (primarily for testing).
 * @returns Absolute path to either `dist/<relPath>.js` or `src/<relPath>`.
 */
export function resolveSubprocessModule(
  packageRoot: string,
  relPath: string,
  options: ResolveSubprocessModuleOptions = {},
): string {
  const checkExists = options.existsSync ?? fsExistsSync
  const srcPath = join(packageRoot, "src", relPath)

  if (isUnderNodeModules(packageRoot)) {
    const jsRelPath = relPath.replace(/\.ts$/, ".js")
    const distPath = join(packageRoot, "dist", jsRelPath)
    if (checkExists(distPath)) {
      return distPath
    }
  }

  return srcPath
}

/**
 * Returns true when the given path sits inside a `node_modules/` directory.
 * Handles both Unix and Windows path separators.
 */
function isUnderNodeModules(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return normalized.includes("/node_modules/")
}

/**
 * Returns true when the running Node version supports
 * `--experimental-transform-types` (available since Node v22.7.0).
 */
function supportsTransformTypes(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number)
  return major > 22 || (major === 22 && minor >= 7)
}
