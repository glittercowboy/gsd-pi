import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { CapturesData, CaptureResolveRequest, CaptureResolveResult } from "../../web/lib/knowledge-captures-types.ts"

const CAPTURES_MODULE_ENV = "GSD_CAPTURES_MODULE"

/**
 * Loads all capture entries via a child process. The child imports the upstream
 * captures module, calls loadAllCaptures() and loadActionableCaptures(), and
 * writes a CapturesData JSON to stdout.
 */
export async function collectCapturesData(projectCwdOverride?: string): Promise<CapturesData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: CAPTURES_MODULE_ENV, relativePath: "src/resources/extensions/gsd/captures.ts" }],
    label: "captures",
  })

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CAPTURES_MODULE_ENV}).href);`,
    `const all = mod.loadAllCaptures(process.env.GSD_CAPTURES_BASE);`,
    'const pending = all.filter(c => c.status === "pending");',
    `const actionable = mod.loadActionableCaptures(process.env.GSD_CAPTURES_BASE);`,
    'const result = { entries: all, pendingCount: pending.length, actionableCount: actionable.length };',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  return await runSubprocess<CapturesData>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_CAPTURES_BASE: projectCwd },
    label: "captures data",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}

/**
 * Resolves (triages) a single capture by calling markCaptureResolved() in a
 * child process. Returns { ok: true, captureId } on success.
 */
export async function resolveCaptureAction(request: CaptureResolveRequest, projectCwdOverride?: string): Promise<CaptureResolveResult> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: CAPTURES_MODULE_ENV, relativePath: "src/resources/extensions/gsd/captures.ts" }],
    label: "captures",
  })

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

  return await runSubprocess<CaptureResolveResult>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_CAPTURES_BASE: projectCwd },
    label: "capture resolve",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}
