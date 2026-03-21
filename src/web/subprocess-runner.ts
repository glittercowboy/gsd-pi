/**
 * Shared subprocess runner for web service files.
 *
 * Every web service that loads upstream GSD extension modules needs to spawn
 * a Node child process with the TS loader, type-stripping flag, and --eval.
 * This module centralises that boilerplate so services only specify what
 * varies: the script, env vars, and module paths.
 */

import { execFile } from "node:child_process"
import { existsSync as defaultExistsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveTypeStrippingFlag } from "./ts-subprocess-flags.ts"

const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Module path resolution
// ---------------------------------------------------------------------------

export interface ModuleSpec {
  /** Environment variable name the child process reads to find this module. */
  envKey: string
  /** Path relative to packageRoot (e.g. "src/resources/extensions/gsd/doctor.ts"). */
  relativePath: string
}

export interface ResolveModulePathsOptions {
  modules: ModuleSpec[]
  /** Override for testing — defaults to fs.existsSync. */
  existsSync?: (path: string) => boolean
  /** Label used in error messages (e.g. "doctor-service"). */
  label?: string
}

export interface ResolvedPaths {
  /** Absolute path to resolve-ts.mjs. */
  tsLoaderPath: string
  /** Environment variable entries mapping each module's envKey to its absolute path. */
  env: Record<string, string>
}

/**
 * Resolves the TS loader path and all module paths, validating that every
 * path exists on disk. Throws a descriptive error if any path is missing.
 */
export function resolveModulePaths(
  packageRoot: string,
  options: ResolveModulePathsOptions,
): ResolvedPaths {
  const checkExists = options.existsSync ?? defaultExistsSync
  const label = options.label ?? "subprocess"

  const tsLoaderPath = join(
    packageRoot,
    "src",
    "resources",
    "extensions",
    "gsd",
    "tests",
    "resolve-ts.mjs",
  )

  const modulePaths: Record<string, string> = {}
  const allPaths = [tsLoaderPath]

  for (const mod of options.modules) {
    const fullPath = join(packageRoot, mod.relativePath)
    modulePaths[mod.envKey] = fullPath
    allPaths.push(fullPath)
  }

  for (const p of allPaths) {
    if (!checkExists(p)) {
      throw new Error(`${label} data provider not found; missing=${p}`)
    }
  }

  return { tsLoaderPath, env: modulePaths }
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

export interface RunSubprocessOptions {
  /** Absolute path to the package root (used as cwd and for flag resolution). */
  packageRoot: string
  /** The --eval script to run in the child process. */
  script: string
  /** Extra environment variables merged onto process.env for the child. */
  env: Record<string, string>
  /** Label for error messages (e.g. "doctor", "forensics"). */
  label: string
  /** Override cwd (defaults to packageRoot). */
  cwd?: string
  /** Max stdout buffer in bytes. Defaults to 2 MB. */
  maxBuffer?: number
  /** Subprocess timeout in milliseconds. Defaults to 30 s. */
  timeoutMs?: number
  /** Resolved TS loader path — if omitted, resolves from packageRoot. */
  tsLoaderPath?: string
  /** Override process.execPath for testing. */
  execPath?: string
}

/**
 * Spawns a Node child process that evaluates `script` with the TS loader and
 * type-stripping flag, parses the stdout as JSON, and returns the result.
 *
 * Replaces the identical `new Promise((resolve, reject) => execFile(...))`
 * callback boilerplate that was duplicated across 12+ web service files.
 */
export async function runSubprocess<T>(options: RunSubprocessOptions): Promise<T> {
  const {
    packageRoot,
    script,
    env: extraEnv,
    label,
    cwd = packageRoot,
    maxBuffer = DEFAULT_MAX_BUFFER,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execPath = process.execPath,
  } = options

  const tsLoaderPath =
    options.tsLoaderPath ??
    join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")

  return await new Promise<T>((resolveResult, reject) => {
    execFile(
      execPath,
      [
        "--import",
        pathToFileURL(tsLoaderPath).href,
        resolveTypeStrippingFlag(packageRoot),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd,
        env: { ...process.env, ...extraEnv },
        maxBuffer,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${label} subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as T)
        } catch (parseError) {
          reject(
            new Error(
              `${label} subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
