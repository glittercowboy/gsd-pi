import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type { UndoInfo, UndoResult } from "../../web/lib/remaining-command-types.ts"

const UNDO_MAX_BUFFER = 2 * 1024 * 1024
const UNDO_MODULE_ENV = "GSD_UNDO_MODULE"
const PATHS_MODULE_ENV = "GSD_PATHS_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Collects information about the last completed unit for display in the undo panel.
 * Reads completed-units.json directly (plain JSON, no child process needed)
 * and scans the activity log directory for associated commits.
 */
export async function collectUndoInfo(projectCwdOverride?: string): Promise<UndoInfo> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { projectCwd } = config

  const gsdDir = join(projectCwd, ".gsd")
  const completedPath = join(gsdDir, "completed-units.json")

  const empty: UndoInfo = {
    lastUnitType: null,
    lastUnitId: null,
    lastUnitKey: null,
    completedCount: 0,
    commits: [],
  }

  if (!existsSync(completedPath)) return empty

  let entries: Array<{ type: string; id: string; key?: string }>
  try {
    entries = JSON.parse(readFileSync(completedPath, "utf-8"))
  } catch {
    return empty
  }

  if (!Array.isArray(entries) || entries.length === 0) return empty

  const last = entries[entries.length - 1]
  const unitType = last.type ?? null
  const unitId = last.id ?? null
  const unitKey = last.key ?? (unitType && unitId ? `${unitType}:${unitId}` : null)

  // Scan activity log for associated commits
  const activityDir = join(gsdDir, "activity")
  let commits: string[] = []
  if (unitType && unitId && existsSync(activityDir)) {
    try {
      const { readdirSync } = await import("node:fs")
      const safeUnitId = unitId.replace(/\//g, "-")
      const files = readdirSync(activityDir)
        .filter((f: string) => f.includes(unitType) && f.includes(safeUnitId) && f.endsWith(".jsonl"))
        .sort()
        .reverse()

      if (files.length > 0) {
        const content = readFileSync(join(activityDir, files[0]), "utf-8")
        const shaRegex = /\b[0-9a-f]{7,40}\b/g
        const commitSet = new Set<string>()
        for (const line of content.split("\n")) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry?.message?.content) {
              const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
              for (const block of blocks) {
                if (block.type === "tool_result" && typeof block.content === "string") {
                  const matches = block.content.match(shaRegex)
                  if (matches) {
                    for (const sha of matches) {
                      if (sha.length >= 7 && !commitSet.has(sha)) {
                        commitSet.add(sha)
                        commits.push(sha)
                      }
                    }
                  }
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } catch {
      // Activity log scanning is best-effort
    }
  }

  return {
    lastUnitType: unitType,
    lastUnitId: unitId,
    lastUnitKey: unitKey,
    completedCount: entries.length,
    commits,
  }
}

/**
 * Executes the undo operation via a child process.
 * Child-process pattern required because undo calls upstream functions that
 * modify git state, completed-units.json, and plan files — all of which
 * use .ts imports that need the resolve-ts.mjs loader.
 *
 * NOTE: The child script uses execSync for git-revert because the upstream
 * undo module already uses it. This is intentionally preserved from the
 * original implementation.
 */
export async function executeUndo(projectCwdOverride?: string): Promise<UndoResult> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const undoResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/undo.ts")
  const pathsResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/paths.ts")
  const undoModulePath = undoResolution.modulePath
  const pathsModulePath = pathsResolution.modulePath

  // For subprocess args we use the undo resolution (both modules share the same compiled-vs-source state)
  if (!undoResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(undoModulePath) || !existsSync(pathsModulePath))) {
    throw new Error(
      `undo service modules not found; checked=${resolveTsLoader},${undoModulePath},${pathsModulePath}`,
    )
  }
  if (undoResolution.useCompiledJs && (!existsSync(undoModulePath) || !existsSync(pathsModulePath))) {
    throw new Error(`undo service modules not found; checked=${undoModulePath},${pathsModulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } = await import("node:fs");',
    'const { join } = await import("node:path");',
    `const undoMod = await import(pathToFileURL(process.env.${UNDO_MODULE_ENV}).href);`,
    `const pathsMod = await import(pathToFileURL(process.env.${PATHS_MODULE_ENV}).href);`,
    'const basePath = process.env.GSD_UNDO_BASE;',
    'const gsdDir = pathsMod.gsdRoot(basePath);',
    'const completedPath = join(gsdDir, "completed-units.json");',
    'if (!existsSync(completedPath)) { process.stdout.write(JSON.stringify({ success: false, message: "No completed units to undo" })); process.exit(0); }',
    'let entries;',
    'try { entries = JSON.parse(readFileSync(completedPath, "utf-8")); } catch { process.stdout.write(JSON.stringify({ success: false, message: "Could not parse completed-units.json" })); process.exit(0); }',
    'if (!Array.isArray(entries) || entries.length === 0) { process.stdout.write(JSON.stringify({ success: false, message: "No completed units to undo" })); process.exit(0); }',
    'const last = entries[entries.length - 1];',
    'const unitType = last.type;',
    'const unitId = last.id;',
    'const parts = unitId ? unitId.split("/") : [];',
    'let planUpdated = false;',
    'if (unitType === "execute-task" && parts.length === 3) { const [mid, sid, tid] = parts; planUpdated = undoMod.uncheckTaskInPlan(basePath, mid, sid, tid); }',
    'let commitsReverted = 0;',
    'const activityDir = join(gsdDir, "activity");',
    'if (existsSync(activityDir)) {',
    '  const commits = undoMod.findCommitsForUnit(activityDir, unitType, unitId);',
    '  if (commits.length > 0) {',
    '    const { execFileSync } = await import("node:child_process");',
    '    for (const sha of commits.reverse()) {',
    '      try { execFileSync("git", ["revert", "--no-commit", sha], { cwd: basePath, stdio: "pipe" }); commitsReverted++; }',
    '      catch { try { execFileSync("git", ["revert", "--abort"], { cwd: basePath, stdio: "pipe" }); } catch {} break; }',
    '    }',
    '  }',
    '}',
    'entries.pop();',
    'writeFileSync(completedPath, JSON.stringify(entries, null, 2), "utf-8");',
    'const results = [`Undone: ${unitType} (${unitId})`];',
    'results.push("  - Removed from completed-units.json");',
    'if (planUpdated) results.push("  - Unchecked task in PLAN");',
    'if (commitsReverted > 0) { results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`); }',
    'process.stdout.write(JSON.stringify({ success: true, message: results.join("\\n") }));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, undoResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<UndoResult>((resolveResult, reject) => {
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
          [UNDO_MODULE_ENV]: undoModulePath,
          [PATHS_MODULE_ENV]: pathsModulePath,
          GSD_UNDO_BASE: projectCwd,
        },
        maxBuffer: UNDO_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`undo subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as UndoResult)
        } catch (parseError) {
          reject(
            new Error(
              `undo subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
