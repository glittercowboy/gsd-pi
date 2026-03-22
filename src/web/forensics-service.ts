import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { ForensicReport } from "../../web/lib/diagnostics-types.ts"

const FORENSICS_MODULE_ENV = "GSD_FORENSICS_MODULE"

/**
 * Loads forensic report data via a child process. Converts the full upstream
 * ForensicReport into a browser-safe subset: deep ExecutionTrace objects are
 * replaced with trace counts and simplified entries, MetricsLedger is flattened
 * to summary totals, and doctorIssues is replaced with a count (doctor panel
 * has its own dedicated API route).
 */
export async function collectForensicsData(projectCwdOverride?: string): Promise<ForensicReport> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: FORENSICS_MODULE_ENV, relativePath: "src/resources/extensions/gsd/forensics.ts" }],
    label: "forensics",
  })

  // The child script loads the upstream module, calls buildForensicReport(),
  // simplifies the output for browser consumption, and writes JSON to stdout.
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${FORENSICS_MODULE_ENV}).href);`,
    `const report = await mod.buildForensicReport(process.env.GSD_FORENSICS_BASE);`,
    // Simplify unitTraces: strip deep ExecutionTrace, keep file/unitType/unitId/seq/mtime
    'const unitTraces = (report.unitTraces || []).map(t => ({',
    '  file: t.file, unitType: t.unitType, unitId: t.unitId, seq: t.seq, mtime: t.mtime,',
    '}));',
    // Flatten metrics to summary
    'let metrics = null;',
    'if (report.metrics && report.metrics.units) {',
    '  const units = report.metrics.units;',
    '  const totalCost = units.reduce((s, u) => s + u.cost, 0);',
    '  const totalDuration = units.reduce((s, u) => s + (u.finishedAt - u.startedAt), 0);',
    '  metrics = { totalUnits: units.length, totalCost, totalDuration };',
    '}',
    'const result = {',
    '  gsdVersion: report.gsdVersion,',
    '  timestamp: report.timestamp,',
    '  basePath: report.basePath,',
    '  activeMilestone: report.activeMilestone,',
    '  activeSlice: report.activeSlice,',
    '  anomalies: report.anomalies,',
    '  recentUnits: report.recentUnits,',
    '  crashLock: report.crashLock,',
    '  doctorIssueCount: (report.doctorIssues || []).length,',
    '  unitTraceCount: unitTraces.length,',
    '  unitTraces,',
    '  completedKeyCount: (report.completedKeys || []).length,',
    '  metrics,',
    '};',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  return await runSubprocess<ForensicReport>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_FORENSICS_BASE: projectCwd },
    label: "forensics data",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}
