import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag } from "./ts-subprocess-flags.ts"
import type { HooksData } from "../../web/lib/remaining-command-types.ts"

const HOOKS_MAX_BUFFER = 512 * 1024
const HOOKS_MODULE_ENV = "GSD_HOOKS_MODULE"

function resolveHooksModulePath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "post-unit-hooks.ts")
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Collects hook configuration and status via a child process.
 * Runtime state (active cycles, hook queue) is not available in a cold child
 * process, so activeCycles will be empty. The child calls getHookStatus() which
 * reads from preferences to build entries, then formatHookStatus() for display.
 */
export async function collectHooksData(projectCwdOverride?: string): Promise<HooksData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const hooksModulePath = resolveHooksModulePath(packageRoot)

  if (!existsSync(resolveTsLoader) || !existsSync(hooksModulePath)) {
    throw new Error(
      `hooks data provider not found; checked=${resolveTsLoader},${hooksModulePath}`,
    )
  }

  // getHookStatus() internally calls resolvePostUnitHooks() and resolvePreDispatchHooks()
  // from preferences.ts, which read from process.cwd()/.gsd/preferences.md.
  // We set cwd to projectCwd so preferences resolution finds the right files.
  // In a cold child process, cycleCounts is empty, so activeCycles will be {}.
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${HOOKS_MODULE_ENV}).href);`,
    'const entries = mod.getHookStatus();',
    'const formattedStatus = mod.formatHookStatus();',
    'process.stdout.write(JSON.stringify({ entries, formattedStatus }));',
  ].join(" ")

  return await new Promise<HooksData>((resolveResult, reject) => {
    execFile(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolveTsLoader).href,
        resolveTypeStrippingFlag(packageRoot),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: projectCwd,
        env: {
          ...process.env,
          [HOOKS_MODULE_ENV]: hooksModulePath,
        },
        maxBuffer: HOOKS_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`hooks data subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as HooksData)
        } catch (parseError) {
          reject(
            new Error(
              `hooks data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
