import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type { SkillHealthReport } from "../../web/lib/diagnostics-types.ts"

const SKILL_HEALTH_MAX_BUFFER = 2 * 1024 * 1024
const SKILL_HEALTH_MODULE_ENV = "GSD_SKILL_HEALTH_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Loads skill health report via a child process.
 * SkillHealthReport is already all plain objects — no Map/Set conversion needed.
 */
export async function collectSkillHealthData(projectCwdOverride?: string): Promise<SkillHealthReport> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/skill-health.ts")
  const skillHealthModulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(skillHealthModulePath))) {
    throw new Error(
      `skill-health data provider not found; checked=${resolveTsLoader},${skillHealthModulePath}`,
    )
  }
  if (moduleResolution.useCompiledJs && !existsSync(skillHealthModulePath)) {
    throw new Error(`skill-health data provider not found; checked=${skillHealthModulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${SKILL_HEALTH_MODULE_ENV}).href);`,
    'const basePath = process.env.GSD_SKILL_HEALTH_BASE;',
    'const report = mod.generateSkillHealthReport(basePath);',
    'process.stdout.write(JSON.stringify(report));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<SkillHealthReport>((resolveResult, reject) => {
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
          [SKILL_HEALTH_MODULE_ENV]: skillHealthModulePath,
          GSD_SKILL_HEALTH_BASE: projectCwd,
        },
        maxBuffer: SKILL_HEALTH_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`skill-health subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as SkillHealthReport)
        } catch (parseError) {
          reject(
            new Error(
              `skill-health subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
