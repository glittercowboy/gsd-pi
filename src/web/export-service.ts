import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveModulePaths, runSubprocess } from "./subprocess-runner.ts"
import type { ExportResult } from "../../web/lib/remaining-command-types.ts"

const EXPORT_MODULE_ENV = "GSD_EXPORT_MODULE"
const EXPORT_MAX_BUFFER = 4 * 1024 * 1024

/**
 * Generates an export file via a child process and returns its content.
 * The child calls writeExportFile() which creates a timestamped file in .gsd/,
 * then reads its content back for browser display.
 */
export async function collectExportData(
  format: "markdown" | "json" = "markdown",
  projectCwdOverride?: string,
): Promise<ExportResult> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolved = resolveModulePaths(packageRoot, {
    modules: [{ envKey: EXPORT_MODULE_ENV, relativePath: "src/resources/extensions/gsd/export.ts" }],
    label: "export",
  })

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${EXPORT_MODULE_ENV}).href);`,
    'const format = process.env.GSD_EXPORT_FORMAT || "markdown";',
    'const basePath = process.env.GSD_EXPORT_BASE;',
    'const filePath = mod.writeExportFile(basePath, format);',
    'if (filePath) {',
    '  const { readFileSync } = await import("node:fs");',
    '  const { basename } = await import("node:path");',
    '  const content = readFileSync(filePath, "utf-8");',
    '  process.stdout.write(JSON.stringify({ content, format, filename: basename(filePath) }));',
    '} else {',
    '  process.stdout.write(JSON.stringify({ content: "No metrics data available for export.", format, filename: "export." + (format === "json" ? "json" : "md") }));',
    '}',
  ].join(" ")

  return await runSubprocess<ExportResult>({
    packageRoot,
    script,
    env: { ...resolved.env, GSD_EXPORT_BASE: projectCwd, GSD_EXPORT_FORMAT: format },
    label: "export data",
    tsLoaderPath: resolved.tsLoaderPath,
    maxBuffer: EXPORT_MAX_BUFFER,
  })
}
