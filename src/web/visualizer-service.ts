import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"

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

/**
 * Loads visualizer data from the current project's filesystem via a child
 * process (required because upstream .ts files use Node ESM .js import
 * extensions that Turbopack cannot resolve). Converts Map fields to Records
 * for safe JSON serialization.
 */
export async function collectVisualizerData(projectCwdOverride?: string): Promise<SerializedVisualizerData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: VISUALIZER_MODULE_ENV, relativePath: "src/resources/extensions/gsd/visualizer-data.ts" }],
    label: "visualizer",
  })

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

  return await runSubprocess<SerializedVisualizerData>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_VISUALIZER_BASE: projectCwd },
    label: "visualizer data",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}
