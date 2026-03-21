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
