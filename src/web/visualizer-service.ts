import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"

const VISUALIZER_MAX_BUFFER = 2 * 1024 * 1024
const VISUALIZER_MODULE_ENV = "GSD_VISUALIZER_MODULE"

/**
 * Browser-safe version of VisualizerData where Map fields are converted to
 * plain Records so JSON.stringify serializes them correctly.
 *
 * Without this conversion, `JSON.stringify(new Map([["M001", 0]]))` produces
 * `"{}"` — silently losing all critical-path slack data.
 */
export interface SerializedVisualizerData {
  milestones: unknown[]
  phase: string
  totals: unknown | null
  byPhase: unknown[]
  bySlice: unknown[]
  byModel: unknown[]
  units: unknown[]
  criticalPath: {
    milestonePath: string[]
    slicePath: string[]
    milestoneSlack: Record<string, number>
    sliceSlack: Record<string, number>
  }
  remainingSliceCount: number
  agentActivity: unknown | null
  changelog: unknown
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Loads visualizer data from the current project's filesystem via a child
 * process (required because upstream .ts files use Node ESM .js import
 * extensions that Turbopack cannot resolve). Converts Map fields to Records
 * for safe JSON serialization.
 */
export async function collectVisualizerData(projectCwdOverride?: string): Promise<SerializedVisualizerData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/visualizer-data.ts")
  const visualizerModulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(visualizerModulePath))) {
    throw new Error(
      `visualizer data provider not found; checked=${resolveTsLoader},${visualizerModulePath}`,
    )
  }
  if (moduleResolution.useCompiledJs && !existsSync(visualizerModulePath)) {
    throw new Error(`visualizer data provider not found; checked=${visualizerModulePath}`)
  }

  // The child script loads the upstream module, calls loadVisualizerData(),
  // converts Map fields to Records, and writes JSON to stdout.
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${VISUALIZER_MODULE_ENV}).href);`,
    `const data = await mod.loadVisualizerData(process.env.GSD_VISUALIZER_BASE);`,
    'const result = {',
    '  ...data,',
    '  criticalPath: {',
    '    milestonePath: data.criticalPath.milestonePath,',
    '    slicePath: data.criticalPath.slicePath,',
    '    milestoneSlack: Object.fromEntries(data.criticalPath.milestoneSlack),',
    '    sliceSlack: Object.fromEntries(data.criticalPath.sliceSlack),',
    '  },',
    '};',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<SerializedVisualizerData>((resolveResult, reject) => {
    execFile(
      process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [VISUALIZER_MODULE_ENV]: visualizerModulePath,
          GSD_VISUALIZER_BASE: projectCwd,
        },
        maxBuffer: VISUALIZER_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`visualizer data subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as SerializedVisualizerData)
        } catch (parseError) {
          reject(
            new Error(
              `visualizer data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
