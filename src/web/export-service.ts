import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag } from "./ts-subprocess-flags.ts"
import type { ExportResult } from "../../web/lib/remaining-command-types.ts"

const EXPORT_MAX_BUFFER = 4 * 1024 * 1024
const EXPORT_MODULE_ENV = "GSD_EXPORT_MODULE"

function resolveExportModulePath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "export.ts")
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

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

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const exportModulePath = resolveExportModulePath(packageRoot)

  if (!existsSync(resolveTsLoader) || !existsSync(exportModulePath)) {
    throw new Error(
      `export data provider not found; checked=${resolveTsLoader},${exportModulePath}`,
    )
  }

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

  return await new Promise<ExportResult>((resolveResult, reject) => {
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
          [EXPORT_MODULE_ENV]: exportModulePath,
          GSD_EXPORT_BASE: projectCwd,
          GSD_EXPORT_FORMAT: format,
        },
        maxBuffer: EXPORT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`export data subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as ExportResult)
        } catch (parseError) {
          reject(
            new Error(
              `export data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
