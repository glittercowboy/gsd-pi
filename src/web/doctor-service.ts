import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { DoctorReport, DoctorFixResult } from "../../web/lib/diagnostics-types.ts"

const DOCTOR_MODULE_ENV = "GSD_DOCTOR_MODULE"

/**
 * Loads doctor diagnostic data (GET — read-only, no fixes applied).
 * Returns full issues array + summary for the doctor panel.
 */
export async function collectDoctorData(scope?: string, projectCwdOverride?: string): Promise<DoctorReport> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: DOCTOR_MODULE_ENV, relativePath: "src/resources/extensions/gsd/doctor.ts" }],
    label: "doctor",
  })

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${DOCTOR_MODULE_ENV}).href);`,
    'const basePath = process.env.GSD_DOCTOR_BASE;',
    'const scope = process.env.GSD_DOCTOR_SCOPE || undefined;',
    'const report = await mod.runGSDDoctor(basePath, { fix: false, scope });',
    'const summary = mod.summarizeDoctorIssues(report.issues);',
    'const result = {',
    '  ok: report.ok,',
    '  issues: report.issues,',
    '  fixesApplied: report.fixesApplied,',
    '  summary,',
    '};',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  return await runSubprocess<DoctorReport>({
    packageRoot,
    script,
    env: {
      ...resolved.env,
      GSD_DOCTOR_BASE: projectCwd,
      GSD_DOCTOR_SCOPE: scope ?? "",
    },
    label: "doctor",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}

/**
 * Applies doctor fixes (POST — mutating action).
 * Returns fix result with list of applied fixes.
 */
export async function applyDoctorFixes(scope?: string, projectCwdOverride?: string): Promise<DoctorFixResult> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: DOCTOR_MODULE_ENV, relativePath: "src/resources/extensions/gsd/doctor.ts" }],
    label: "doctor",
  })

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${DOCTOR_MODULE_ENV}).href);`,
    'const basePath = process.env.GSD_DOCTOR_BASE;',
    'const scope = process.env.GSD_DOCTOR_SCOPE || undefined;',
    'const report = await mod.runGSDDoctor(basePath, { fix: true, scope });',
    'const result = {',
    '  ok: report.ok,',
    '  fixesApplied: report.fixesApplied,',
    '};',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  return await runSubprocess<DoctorFixResult>({
    packageRoot,
    script,
    env: {
      ...resolved.env,
      GSD_DOCTOR_BASE: projectCwd,
      GSD_DOCTOR_SCOPE: scope ?? "",
    },
    label: "doctor fix",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}
