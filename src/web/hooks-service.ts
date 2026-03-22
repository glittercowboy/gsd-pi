import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { HooksData } from "../../web/lib/remaining-command-types.ts"

const HOOKS_MAX_BUFFER = 512 * 1024
const HOOKS_MODULE_ENV = "GSD_HOOKS_MODULE"

/**
 * Collects hook configuration and status via a child process.
 * Runtime state (active cycles, hook queue) is not available in a cold child
 * process, so activeCycles will be empty. The child calls getHookStatus() which
 * reads from preferences to build entries, then formatHookStatus() for display.
 */
export async function collectHooksData(projectCwdOverride?: string): Promise<HooksData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: HOOKS_MODULE_ENV, relativePath: "src/resources/extensions/gsd/post-unit-hooks.ts" }],
    label: "hooks",
  })

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

  return await runSubprocess<HooksData>({
    packageRoot,
    script,
    env: { ...resolved.env },
    label: "hooks data",
    tsLoaderPath: resolved.tsLoaderPath,
    cwd: projectCwd,
    maxBuffer: HOOKS_MAX_BUFFER,
  })
}
