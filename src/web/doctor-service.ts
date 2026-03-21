import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag } from "./ts-subprocess-flags.ts"
import type { DoctorReport, DoctorFixResult } from "../../web/lib/diagnostics-types.ts"

const DOCTOR_MAX_BUFFER = 2 * 1024 * 1024
const DOCTOR_MODULE_ENV = "GSD_DOCTOR_MODULE"

function resolveDoctorModulePath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "doctor.ts")
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

function validateModulePaths(
  resolveTsLoader: string,
  doctorModulePath: string,
): void {
  if (!existsSync(resolveTsLoader) || !existsSync(doctorModulePath)) {
    throw new Error(
      `doctor data provider not found; checked=${resolveTsLoader},${doctorModulePath}`,
    )
  }
}

function runDoctorChild(
  packageRoot: string,
  projectCwd: string,
  script: string,
  resolveTsLoader: string,
  doctorModulePath: string,
  scope?: string,
): Promise<string> {
  return new Promise<string>((resolveResult, reject) => {
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
          [DOCTOR_MODULE_ENV]: doctorModulePath,
          GSD_DOCTOR_BASE: projectCwd,
          GSD_DOCTOR_SCOPE: scope ?? "",
        },
        maxBuffer: DOCTOR_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`doctor subprocess failed: ${stderr || error.message}`))
          return
        }
        resolveResult(stdout)
      },
    )
  })
}

/**
 * Loads doctor diagnostic data (GET — read-only, no fixes applied).
 * Returns full issues array + summary for the doctor panel.
 */
export async function collectDoctorData(scope?: string, projectCwdOverride?: string): Promise<DoctorReport> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const doctorModulePath = resolveDoctorModulePath(packageRoot)
  validateModulePaths(resolveTsLoader, doctorModulePath)

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

  const stdout = await runDoctorChild(
    packageRoot, projectCwd, script, resolveTsLoader, doctorModulePath, scope,
  )

  try {
    return JSON.parse(stdout) as DoctorReport
  } catch (parseError) {
    throw new Error(
      `doctor subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    )
  }
}

/**
 * Applies doctor fixes (POST — mutating action).
 * Returns fix result with list of applied fixes.
 */
export async function applyDoctorFixes(scope?: string, projectCwdOverride?: string): Promise<DoctorFixResult> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const doctorModulePath = resolveDoctorModulePath(packageRoot)
  validateModulePaths(resolveTsLoader, doctorModulePath)

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

  const stdout = await runDoctorChild(
    packageRoot, projectCwd, script, resolveTsLoader, doctorModulePath, scope,
  )

  try {
    return JSON.parse(stdout) as DoctorFixResult
  } catch (parseError) {
    throw new Error(
      `doctor fix subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    )
  }
}
