import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { agentDir as defaultAgentDir, sessionsDir as defaultSessionsDir, webPreferencesPath as defaultWebPreferencesPath } from './app-paths.js'
import { getProjectSessionsDir } from './project-sessions.js'
import { launchWebMode, stopWebMode, type WebModeLaunchStatus, type WebModeStopOptions, type WebModeStopResult } from './web-mode.js'

export interface CliFlags {
  mode?: 'text' | 'json' | 'rpc' | 'mcp'
  print?: boolean
  continue?: boolean
  noSession?: boolean
  worktree?: boolean | string
  model?: string
  listModels?: string | true
  extensions: string[]
  appendSystemPrompt?: string
  tools?: string[]
  messages: string[]
  web?: boolean
  /** Optional project path for web mode: `gsd --web <path>` or `gsd web start <path>` */
  webPath?: string
  /** Custom host to bind web server to: `--host 0.0.0.0` */
  webHost?: string
  /** Custom port for web server: `--port 8080` */
  webPort?: number
  /** Additional allowed origins for CORS: `--allowed-origins http://192.168.1.10:8080` */
  webAllowedOrigins?: string[]

  /** Set by `gsd sessions` when the user picks a specific session to resume */
  _selectedSessionPath?: string
}

type WritableLike = Pick<typeof process.stderr, 'write'>

export interface RunWebCliBranchDeps {
  runWebMode?: typeof launchWebMode
  stopWebMode?: (deps: Parameters<typeof stopWebMode>[0], options?: WebModeStopOptions) => WebModeStopResult
  cwd?: () => string
  stderr?: WritableLike
  baseSessionsDir?: string
  agentDir?: string
  webPreferencesPath?: string
}

export function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { extensions: [], messages: [] }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i]
      if (mode === 'text' || mode === 'json' || mode === 'rpc' || mode === 'mcp') flags.mode = mode
    } else if (arg === '--print' || arg === '-p') {
      flags.print = true
    } else if (arg === '--continue' || arg === '-c') {
      flags.continue = true
    } else if (arg === '--no-session') {
      flags.noSession = true
    } else if (arg === '--worktree' || arg === '-w') {
      // -w with no value → auto-generate name; -w <name> → use that name
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.worktree = args[++i]
      } else {
        flags.worktree = true
      }
    } else if (arg === '--web') {
      flags.web = true
      // Peek at next arg — if it looks like a path (not another flag), capture it
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.webPath = args[++i]
      }
    } else if (arg === '--host' && i + 1 < args.length) {
      flags.webHost = args[++i]
    } else if (arg === '--port' && i + 1 < args.length) {
      const portStr = args[++i]
      const port = parseInt(portStr, 10)
      if (Number.isFinite(port) && port > 0 && port < 65536) {
        flags.webPort = port
      }
    } else if (arg === '--allowed-origins' && i + 1 < args.length) {
      const origins = args[++i].split(',').map(o => o.trim()).filter(Boolean)
      flags.webAllowedOrigins = (flags.webAllowedOrigins ?? []).concat(origins)
    } else if (arg === '--model' && i + 1 < args.length) {
      flags.model = args[++i]
    } else if (arg === '--extension' && i + 1 < args.length) {
      flags.extensions.push(args[++i])
    } else if (arg === '--append-system-prompt' && i + 1 < args.length) {
      flags.appendSystemPrompt = args[++i]
    } else if (arg === '--tools' && i + 1 < args.length) {
      flags.tools = args[++i].split(',')
    } else if (arg === '--list-models') {
      flags.listModels = (i + 1 < args.length && !args[i + 1].startsWith('-')) ? args[++i] : true
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      flags.messages.push(arg)
    }
  }
  return flags
}

export function buildHeadlessAutoArgs(flags: Pick<CliFlags, 'messages' | 'model'>): string[] {
  return flags.model ? ['--model', flags.model, ...flags.messages] : [...flags.messages]
}

export { getProjectSessionsDir } from './project-sessions.js'

export function migrateLegacyFlatSessions(baseSessionsDir: string, projectSessionsDir: string): void {
  if (!existsSync(baseSessionsDir)) return

  try {
    const entries = readdirSync(baseSessionsDir)
    const flatJsonl = entries.filter((file) => file.endsWith('.jsonl'))
    if (flatJsonl.length === 0) return

    mkdirSync(projectSessionsDir, { recursive: true })
    for (const file of flatJsonl) {
      const src = join(baseSessionsDir, file)
      const dst = join(projectSessionsDir, file)
      if (!existsSync(dst)) {
        renameSync(src, dst)
      }
    }
  } catch {
    // Non-fatal — don't block startup if migration fails
  }
}

function emitWebModeFailure(stderr: WritableLike, status: WebModeLaunchStatus): void {
  if (status.ok) return
  stderr.write(`[gsd] Web mode launch failed: ${status.failureReason}\n`)
}

/**
 * Resolve the working directory for context-aware launch detection.
 *
 * If the user has configured a dev root via onboarding and their cwd is inside
 * a project under that dev root, return the one-level-deep project directory.
 * Otherwise, return the cwd unchanged (browser picker handles selection).
 *
 * Edge cases handled:
 * - Missing or unreadable prefs file → cwd unchanged
 * - No devRoot field in prefs → cwd unchanged
 * - devRoot path doesn't exist (stale) → cwd unchanged
 * - cwd IS the devRoot → cwd unchanged (picker selects)
 * - cwd outside devRoot → cwd unchanged
 */
export function resolveContextAwareCwd(currentCwd: string, prefsPath: string): string {
  // 1. Read preferences file
  let prefs: Record<string, unknown>
  try {
    const raw = readFileSync(prefsPath, 'utf-8')
    prefs = JSON.parse(raw)
  } catch {
    return currentCwd
  }

  // 2. Extract devRoot
  const devRoot = prefs.devRoot
  if (typeof devRoot !== 'string' || !devRoot) {
    return currentCwd
  }

  // 3. Resolve both paths to absolute
  const resolvedCwd = resolve(currentCwd)
  const resolvedDevRoot = resolve(devRoot)

  // 4. Check devRoot still exists
  if (!existsSync(resolvedDevRoot)) {
    return currentCwd
  }

  // 5. If cwd IS the devRoot → unchanged (picker handles selection)
  if (resolvedCwd === resolvedDevRoot) {
    return currentCwd
  }

  // 6. If cwd is inside devRoot, extract one-level-deep project directory
  const prefix = resolvedDevRoot + sep
  if (resolvedCwd.startsWith(prefix)) {
    const relative = resolvedCwd.slice(prefix.length)
    const firstSegment = relative.split(sep)[0]
    if (firstSegment) {
      return join(resolvedDevRoot, firstSegment)
    }
  }

  // 7. cwd outside devRoot → unchanged
  return currentCwd
}

export type RunWebCliBranchResult =
  | { handled: false }
  | {
      handled: true
      exitCode: number
      action: 'start'
      status: WebModeLaunchStatus
      launchInputs: { cwd: string; projectSessionsDir: string; agentDir: string }
    }
  | {
      handled: true
      exitCode: number
      action: 'stop'
      stopResult: WebModeStopResult
    }

export async function runWebCliBranch(
  flags: CliFlags,
  deps: RunWebCliBranchDeps = {},
): Promise<RunWebCliBranchResult> {
  // Handle `gsd web stop [path|--all]` subcommand
  if (flags.messages[0] === 'web' && flags.messages[1] === 'stop') {
    const stderr = deps.stderr ?? process.stderr
    const stopArg = flags.messages[2]
    const isAll = stopArg === 'all'
    const stopCwd = stopArg && !isAll ? resolve((deps.cwd ?? (() => process.cwd()))(), stopArg) : undefined
    const stopResult = (deps.stopWebMode ?? stopWebMode)({ stderr }, {
      projectCwd: stopCwd,
      all: isAll,
    })
    return {
      handled: true,
      exitCode: stopResult.ok ? 0 : 1,
      action: 'stop',
      stopResult,
    }
  }

  // `gsd web [start] [path]` is an alias for `gsd --web [path]`
  // Matches: `gsd web`, `gsd web start`, `gsd web start <path>`, `gsd web <path>`
  const isWebSubcommand = flags.messages[0] === 'web' && flags.messages[1] !== 'stop'
  if (!flags.web && !isWebSubcommand) {
    return { handled: false }
  }

  const stderr = deps.stderr ?? process.stderr
  const defaultCwd = (deps.cwd ?? (() => process.cwd()))()

  // Resolve project path from multiple forms:
  //   gsd --web <path>           → flags.webPath
  //   gsd web start <path>       → messages[2]
  //   gsd web <path>             → messages[1] (when not "start")
  let webPath = flags.webPath
  if (!webPath && isWebSubcommand) {
    if (flags.messages[1] === 'start') {
      webPath = flags.messages[2]
    } else if (flags.messages[1]) {
      webPath = flags.messages[1]
    }
  }

  let currentCwd: string
  if (webPath) {
    currentCwd = resolve(defaultCwd, webPath)
    const checkExists = existsSync
    if (!checkExists(currentCwd)) {
      stderr.write(`[gsd] Project path does not exist: ${currentCwd}\n`)
      return {
        handled: true,
        exitCode: 1,
        action: 'start',
        status: {
          mode: 'web',
          ok: false,
          cwd: currentCwd,
          projectSessionsDir: '',
          host: '127.0.0.1',
          port: null,
          url: null,
          hostKind: 'unresolved',
          hostPath: null,
          hostRoot: null,
          failureReason: `project path does not exist: ${currentCwd}`,
        },
        launchInputs: { cwd: currentCwd, projectSessionsDir: '', agentDir: deps.agentDir ?? defaultAgentDir },
      }
    }
    stderr.write(`[gsd] Using project path: ${currentCwd}\n`)
  } else {
    currentCwd = defaultCwd
  }

  // Context-aware launch: if cwd is inside a project under the configured dev root,
  // resolve to the project directory so the browser opens directly into it
  currentCwd = resolveContextAwareCwd(currentCwd, deps.webPreferencesPath ?? defaultWebPreferencesPath)

  const baseSessionsDir = deps.baseSessionsDir ?? defaultSessionsDir
  const agentDir = deps.agentDir ?? defaultAgentDir
  const projectSessionsDir = getProjectSessionsDir(currentCwd, baseSessionsDir)

  migrateLegacyFlatSessions(baseSessionsDir, projectSessionsDir)
  const status = await (deps.runWebMode ?? launchWebMode)({
    cwd: currentCwd,
    projectSessionsDir,
    agentDir,
    host: flags.webHost,
    port: flags.webPort,
    allowedOrigins: flags.webAllowedOrigins,
  })

  if (!status.ok) {
    emitWebModeFailure(stderr, status)
  }

  return {
    handled: true,
    exitCode: status.ok ? 0 : 1,
    action: 'start',
    status,
    launchInputs: {
      cwd: currentCwd,
      projectSessionsDir,
      agentDir,
    },
  }
}
