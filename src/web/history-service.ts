import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag } from "./ts-subprocess-flags.ts"
import type { HistoryData } from "../../web/lib/remaining-command-types.ts"

const HISTORY_MAX_BUFFER = 2 * 1024 * 1024
const HISTORY_MODULE_ENV = "GSD_HISTORY_MODULE"

function resolveHistoryModulePath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "metrics.ts")
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Loads history/metrics data via a child process.
 * Reads the metrics ledger from disk and computes aggregation views
 * (totals, byPhase, bySlice, byModel) for browser consumption.
 */
export async function collectHistoryData(projectCwdOverride?: string): Promise<HistoryData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const historyModulePath = resolveHistoryModulePath(packageRoot)

  if (!existsSync(resolveTsLoader) || !existsSync(historyModulePath)) {
    throw new Error(
      `history data provider not found; checked=${resolveTsLoader},${historyModulePath}`,
    )
  }

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

  return await new Promise<HistoryData>((resolveResult, reject) => {
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
        cwd: packageRoot,
        env: {
          ...process.env,
          [HISTORY_MODULE_ENV]: historyModulePath,
          GSD_HISTORY_BASE: projectCwd,
        },
        maxBuffer: HISTORY_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`history data subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as HistoryData)
        } catch (parseError) {
          reject(
            new Error(
              `history data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
