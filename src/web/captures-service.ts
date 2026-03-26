import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type { CapturesData, CaptureResolveRequest, CaptureResolveResult } from "../../web/lib/knowledge-captures-types.ts"

const CAPTURES_MAX_BUFFER = 2 * 1024 * 1024
const CAPTURES_MODULE_ENV = "GSD_CAPTURES_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Loads all capture entries via a child process. The child imports the upstream
 * captures module, calls loadAllCaptures() and loadActionableCaptures(), and
 * writes a CapturesData JSON to stdout.
 */
export async function collectCapturesData(projectCwdOverride?: string): Promise<CapturesData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/captures.ts")
  const capturesModulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(capturesModulePath))) {
    throw new Error(
      `captures data provider not found; checked=${resolveTsLoader},${capturesModulePath}`,
    )
  }
  if (moduleResolution.useCompiledJs && !existsSync(capturesModulePath)) {
    throw new Error(`captures data provider not found; checked=${capturesModulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CAPTURES_MODULE_ENV}).href);`,
    `const all = mod.loadAllCaptures(process.env.GSD_CAPTURES_BASE);`,
    'const pending = all.filter(c => c.status === "pending");',
    `const actionable = mod.loadActionableCaptures(process.env.GSD_CAPTURES_BASE);`,
    'const result = { entries: all, pendingCount: pending.length, actionableCount: actionable.length };',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<CapturesData>((resolveResult, reject) => {
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
          [CAPTURES_MODULE_ENV]: capturesModulePath,
          GSD_CAPTURES_BASE: projectCwd,
        },
        maxBuffer: CAPTURES_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`captures data subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as CapturesData)
        } catch (parseError) {
          reject(
            new Error(
              `captures data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}

/**
 * Resolves (triages) a single capture by calling markCaptureResolved() in a
 * child process. Returns { ok: true, captureId } on success.
 */
export async function resolveCaptureAction(request: CaptureResolveRequest, projectCwdOverride?: string): Promise<CaptureResolveResult> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/captures.ts")
  const capturesModulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(capturesModulePath))) {
    throw new Error(
      `captures data provider not found; checked=${resolveTsLoader},${capturesModulePath}`,
    )
  }
  if (moduleResolution.useCompiledJs && !existsSync(capturesModulePath)) {
    throw new Error(`captures data provider not found; checked=${capturesModulePath}`)
  }

  const safeId = JSON.stringify(request.captureId)
  const safeClassification = JSON.stringify(request.classification)
  const safeResolution = JSON.stringify(request.resolution)
  const safeRationale = JSON.stringify(request.rationale)

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CAPTURES_MODULE_ENV}).href);`,
    `mod.markCaptureResolved(process.env.GSD_CAPTURES_BASE, ${safeId}, ${safeClassification}, ${safeResolution}, ${safeRationale});`,
    `process.stdout.write(JSON.stringify({ ok: true, captureId: ${safeId} }));`,
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<CaptureResolveResult>((resolveResult, reject) => {
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
          [CAPTURES_MODULE_ENV]: capturesModulePath,
          GSD_CAPTURES_BASE: projectCwd,
        },
        maxBuffer: CAPTURES_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`capture resolve subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as CaptureResolveResult)
        } catch (parseError) {
          reject(
            new Error(
              `capture resolve subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
