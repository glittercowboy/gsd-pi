import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { SkillHealthReport } from "../../web/lib/diagnostics-types.ts"

const SKILL_HEALTH_MODULE_ENV = "GSD_SKILL_HEALTH_MODULE"

/**
 * Loads skill health report via a child process.
 * SkillHealthReport is already all plain objects — no Map/Set conversion needed.
 */
export async function collectSkillHealthData(projectCwdOverride?: string): Promise<SkillHealthReport> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: SKILL_HEALTH_MODULE_ENV, relativePath: "src/resources/extensions/gsd/skill-health.ts" }],
    label: "skill-health",
  })

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${SKILL_HEALTH_MODULE_ENV}).href);`,
    'const basePath = process.env.GSD_SKILL_HEALTH_BASE;',
    'const report = mod.generateSkillHealthReport(basePath);',
    'process.stdout.write(JSON.stringify(report));',
  ].join(" ")

  return await runSubprocess<SkillHealthReport>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_SKILL_HEALTH_BASE: projectCwd },
    label: "skill-health",
    tsLoaderPath: resolved.tsLoaderPath,
  })
}
