import { existsSync as defaultExistsSync } from "node:fs"
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
 * works regardless of whether the file is under `node_modules/`. On older
 * Node versions (< 22.7) that lack both flags, this falls back to
 * `--experimental-strip-types` (the caller's loader handles the rest).
 */
export function resolveTypeStrippingFlag(packageRoot: string): string {
  const needsTransform =
    isUnderNodeModules(packageRoot) && supportsTransformTypes()
  return needsTransform
    ? "--experimental-transform-types"
    : "--experimental-strip-types"
}

/**
 * Returns true when the given path sits inside a `node_modules/` directory.
 * Handles both Unix and Windows path separators.
 */
export function isUnderNodeModules(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return normalized.includes("/node_modules/")
}

export interface SubprocessModuleResolution {
  /** Absolute path to the module file (either src/.ts or dist/.js). */
  modulePath: string
  /** When true the module is pre-compiled JS — skip TS flags and loader. */
  useCompiledJs: boolean
}

/**
 * Resolves a subprocess module path, preferring compiled `dist/*.js` when the
 * package root is under `node_modules/`.
 *
 * Node v24 unconditionally refuses `.ts` files under `node_modules/` — even
 * with `--experimental-transform-types`.  When GSD is installed globally via
 * npm, every subprocess that loads a `.ts` extension module crashes with
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
 *
 * The compiled JS files already ship in the npm package (`dist/` is in the
 * `files` array in package.json) and are the correct artefacts to use when
 * running from a packaged install.
 *
 * @param packageRoot  Absolute path to the GSD package root.
 * @param relPath      Path relative to `src/`, e.g.
 *                     `"resources/extensions/gsd/workspace-index.ts"`.
 * @param checkExists  Optional `existsSync` override (for testing).
 */
export function resolveSubprocessModule(
  packageRoot: string,
  relPath: string,
  checkExists: (path: string) => boolean = defaultExistsSync,
): SubprocessModuleResolution {
  if (isUnderNodeModules(packageRoot)) {
    const jsRelPath = relPath.replace(/\.ts$/, ".js")
    const distPath = join(packageRoot, "dist", jsRelPath)
    if (checkExists(distPath)) {
      return { modulePath: distPath, useCompiledJs: true }
    }
  }

  return {
    modulePath: join(packageRoot, "src", relPath),
    useCompiledJs: false,
  }
}

/**
 * Builds the Node.js subprocess prefix args for running a GSD extension module.
 *
 * When the module resolved to compiled JS (`useCompiledJs === true`), returns
 * only `["--input-type=module"]` — no TS loader, no TS stripping flag.
 *
 * When the module is TypeScript source, returns the full prefix:
 * `["--import", <loaderHref>, <tsFlag>, "--input-type=module"]`.
 */
export function buildSubprocessPrefixArgs(
  packageRoot: string,
  resolution: SubprocessModuleResolution,
  tsLoaderHref: string,
): string[] {
  if (resolution.useCompiledJs) {
    return ["--input-type=module"]
  }
  return [
    "--import",
    tsLoaderHref,
    resolveTypeStrippingFlag(packageRoot),
    "--input-type=module",
  ]
}

/**
 * Returns true when the running Node version supports
 * `--experimental-transform-types` (available since Node v22.7.0).
 */
function supportsTransformTypes(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number)
  return major > 22 || (major === 22 && minor >= 7)
}
