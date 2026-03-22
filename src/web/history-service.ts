import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { HistoryData } from "../../web/lib/remaining-command-types.ts"

const HISTORY_MODULE_ENV = "GSD_HISTORY_MODULE"

/**
 * Loads history/metrics data via a child process.
 * Reads the metrics ledger from disk and computes aggregation views
 * (totals, byPhase, bySlice, byModel) for browser consumption.
 */
export async function collectHistoryData(projectCwdOverride?: string): Promise<HistoryData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: HISTORY_MODULE_ENV, relativePath: "src/resources/extensions/gsd/metrics.ts" }],
    label: "history",
  })

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${HISTORY_MODULE_ENV}).href);`,
    `const ledger = mod.loadLedgerFromDisk(process.env.GSD_HISTORY_BASE);`,
    'const units = ledger ? ledger.units : [];',
    'const totals = mod.getProjectTotals(units);',
    'const byPhase = mod.aggregateByPhase(units);',
    'const bySlice = mod.aggregateBySlice(units);',
    'const byModel = mod.aggregateByModel(units);',
    'process.stdout.write(JSON.stringify({ units, totals, byPhase, bySlice, byModel }));',
  ].join(" ")

  return await runSubprocess<HistoryData>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_HISTORY_BASE: projectCwd },
    label: "history data",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}
