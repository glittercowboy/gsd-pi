import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  runPackageCommand,
  SettingsManager,
  SessionManager,
  createAgentSession,
  InteractiveMode,
  runPrintMode,
  runRpcMode,
} from '@gsd/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, sessionsDir, authFilePath } from './app-paths.js'
import { initResources, buildResourceLoader, getNewerManagedResourceVersion } from './resource-loader.js'
import { ensureManagedTools } from './tool-bootstrap.js'
import { loadStoredEnvKeys } from './wizard.js'
import { migratePiCredentials } from './pi-migration.js'
import { validateConfiguredModel } from './startup-model-validation.js'
import { shouldRunOnboarding, runOnboarding } from './onboarding.js'
import chalk from 'chalk'
import { checkForUpdates } from './update-check.js'
import { printHelp, printSubcommandHelp } from './help-text.js'
import { applySecurityOverrides } from './security-overrides.js'
import {
  parseCliArgs as parseWebCliArgs,
  runWebCliBranch,
  migrateLegacyFlatSessions,
} from './cli-web-branch.js'
import { stopWebMode } from './web-mode.js'
import { getProjectSessionsDir } from './project-sessions.js'
import { markStartup, printStartupTimings } from './startup-timings.js'
import { bootstrapRtk, GSD_RTK_DISABLED_ENV } from './rtk.js'
import { loadEffectiveGSDPreferences } from './resources/extensions/gsd/preferences.js'

// ---------------------------------------------------------------------------
// V8 compile cache — Node 22+ can cache compiled bytecode across runs,
// eliminating repeated parse/compile overhead for unchanged modules.
// Must be set early so dynamic imports (extensions, lazy subcommands) benefit.
// ---------------------------------------------------------------------------
if (parseInt(process.versions.node) >= 22) {
  process.env.NODE_COMPILE_CACHE ??= join(agentDir, '.compile-cache')
}

// ---------------------------------------------------------------------------
// Minimal CLI arg parser — detects print/subagent mode flags
// ---------------------------------------------------------------------------
interface CliFlags {
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
  webPath?: string

  /** Set by `gsd sessions` when the user picks a specific session to resume */
  _selectedSessionPath?: string
}

function exitIfManagedResourcesAreNewer(currentAgentDir: string): void {
  const currentVersion = process.env.GSD_VERSION || '0.0.0'
  const managedVersion = getNewerManagedResourceVersion(currentAgentDir, currentVersion)
  if (!managedVersion) {
    return
  }

  process.stderr.write(
    `[gsd] ${chalk.yellow('Version mismatch detected')}\n` +
    `[gsd] Synced resources are from ${chalk.bold(`v${managedVersion}`)}, but this \`gsd\` binary is ${chalk.dim(`v${currentVersion}`)}.\n` +
    `[gsd] Run ${chalk.bold('npm install -g gsd-pi@latest')} or ${chalk.bold('gsd update')}, then try again.\n`,
  )
  process.exit(1)
}

function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { extensions: [], messages: [] }
  const args = argv.slice(2) // skip node + script
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode' && i + 1 < args.length) {
      const m = args[++i]
      if (m === 'text' || m === 'json' || m === 'rpc' || m === 'mcp') flags.mode = m
    } else if (arg === '--print' || arg === '-p') {
      flags.print = true
    } else if (arg === '--continue' || arg === '-c') {
      flags.continue = true
    } else if (arg === '--no-session') {
      flags.noSession = true
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
    } else if (arg === '--version' || arg === '-v') {
      process.stdout.write((process.env.GSD_VERSION || '0.0.0') + '\n')
      process.exit(0)
    } else if (arg === '--worktree' || arg === '-w') {
      // -w with no value → auto-generate name; -w <name> → use that name
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.worktree = args[++i]
      } else {
        flags.worktree = true
      }
    } else if (arg === '--help' || arg === '-h') {
      printHelp(process.env.GSD_VERSION || '0.0.0')
      process.exit(0)
    } else if (arg === '--web') {
      flags.web = true
      // Capture optional project path after --web (not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.webPath = args[++i]
      }
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      flags.messages.push(arg)
    }
  }
  return flags
}

const cliFlags = parseCliArgs(process.argv)
const isPrintMode = cliFlags.print || cliFlags.mode !== undefined

// Early resource-skew check — must run before TTY gate so version mismatch
// errors surface even in non-TTY environments.
async function ensureRtkBootstrap(): Promise<void> {
  if ((ensureRtkBootstrap as { _done?: boolean })._done) return

  // RTK is opt-in via experimental.rtk preference. Default: disabled.
  // Honor GSD_RTK_DISABLED if already explicitly set in the environment
  // (env var takes precedence over preferences for manual override).
  if (!process.env[GSD_RTK_DISABLED_ENV]) {
    const prefs = loadEffectiveGSDPreferences();
    const rtkEnabled = prefs?.preferences.experimental?.rtk === true;
    if (!rtkEnabled) {
      process.env[GSD_RTK_DISABLED_ENV] = "1";
    }
  }

  const rtkStatus = await bootstrapRtk()
  ;(ensureRtkBootstrap as { _done?: boolean })._done = true
  markStartup('bootstrapRtk')
  if (!rtkStatus.available && rtkStatus.supported && rtkStatus.enabled && rtkStatus.reason) {
    process.stderr.write(`[gsd] Warning: RTK unavailable — continuing without shell-command compression (${rtkStatus.reason}).\n`)
  }
}

// `gsd update` — update to the latest version via npm
if (cliFlags.messages[0] === 'update') {
  const { runUpdate } = await import('./update-cmd.js')
  await runUpdate()
  process.exit(0)
}

exitIfManagedResourcesAreNewer(agentDir)

// Early TTY check — must come before heavy initialization to avoid dangling
// handles that prevent process.exit() from completing promptly.
const hasSubcommand = cliFlags.messages.length > 0
if (!process.stdin.isTTY && !isPrintMode && !hasSubcommand && !cliFlags.listModels && !cliFlags.web) {
  process.stderr.write('[gsd] Error: Interactive mode requires a terminal (TTY).\n')
  process.stderr.write('[gsd] Non-interactive alternatives:\n')
  process.stderr.write('[gsd]   gsd auto                       Auto-mode (pipeable, no TUI)\n')
  process.stderr.write('[gsd]   gsd --print "your message"     Single-shot prompt\n')
  process.stderr.write('[gsd]   gsd --mode rpc                 JSON-RPC over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode mcp                 MCP server over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode text "message"      Text output mode\n')
  process.exit(1)
}

// `gsd <subcommand> --help` — show subcommand-specific help
const subcommand = cliFlags.messages[0]
if (subcommand && process.argv.includes('--help')) {
  if (printSubcommandHelp(subcommand, process.env.GSD_VERSION || '0.0.0')) {
    process.exit(0)
  }
}

const packageCommand = await runPackageCommand({
  appName: 'gsd',
  args: process.argv.slice(2),
  cwd: process.cwd(),
  agentDir,
  stdout: process.stdout,
  stderr: process.stderr,
  allowedCommands: new Set(['install', 'remove', 'list']),
})
if (packageCommand.handled) {
  process.exit(packageCommand.exitCode)
}

// `gsd config` — replay the setup wizard and exit
if (cliFlags.messages[0] === 'config') {
  const authStorage = AuthStorage.create(authFilePath)
  loadStoredEnvKeys(authStorage)
  await runOnboarding(authStorage)
  process.exit(0)
}

// `gsd web stop [path|all]` — stop web server before anything else
if (cliFlags.messages[0] === 'web' && cliFlags.messages[1] === 'stop') {
  const webFlags = parseWebCliArgs(process.argv)
  const webBranch = await runWebCliBranch(webFlags, {
    stopWebMode,
    stderr: process.stderr,
    baseSessionsDir: sessionsDir,
    agentDir,
  })
  if (webBranch.handled) {
    process.exit(webBranch.exitCode)
  }
}

// `gsd --web [path]` or `gsd web [start] [path]` — launch browser-only web mode
if (cliFlags.web || (cliFlags.messages[0] === 'web' && cliFlags.messages[1] !== 'stop')) {
  await ensureRtkBootstrap()
  const webFlags = parseWebCliArgs(process.argv)
  const webBranch = await runWebCliBranch(webFlags, {
    stderr: process.stderr,
    baseSessionsDir: sessionsDir,
    agentDir,
  })
  if (webBranch.handled) {
    process.exit(webBranch.exitCode)
  }
}


// `gsd sessions` — list past sessions and pick one to resume
if (cliFlags.messages[0] === 'sessions') {
  const cwd = process.cwd()
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  const projectSessionsDir = join(sessionsDir, safePath)

  process.stderr.write(chalk.dim(`Loading sessions for ${cwd}...\n`))
  const sessions = await SessionManager.list(cwd, projectSessionsDir)

  if (sessions.length === 0) {
    process.stderr.write(chalk.yellow('No sessions found for this directory.\n'))
    process.exit(0)
  }

  process.stderr.write(chalk.bold(`\n  Sessions (${sessions.length}):\n\n`))

  const maxShow = 20
  const toShow = sessions.slice(0, maxShow)
  for (let i = 0; i < toShow.length; i++) {
    const s = toShow[i]
    const date = s.modified.toLocaleString()
    const msgs = s.messageCount
    const name = s.name ? ` ${chalk.cyan(s.name)}` : ''
    const preview = s.firstMessage
      ? s.firstMessage.replace(/\n/g, ' ').substring(0, 80)
      : chalk.dim('(empty)')
    const num = String(i + 1).padStart(3)
    process.stderr.write(`  ${chalk.bold(num)}. ${chalk.green(date)} ${chalk.dim(`(${msgs} msgs)`)}${name}\n`)
    process.stderr.write(`       ${chalk.dim(preview)}\n\n`)
  }

  if (sessions.length > maxShow) {
    process.stderr.write(chalk.dim(`  ... and ${sessions.length - maxShow} more\n\n`))
  }

  // Interactive selection
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.bold('  Enter session number to resume (or q to quit): '), resolve)
  })
  rl.close()

  const choice = parseInt(answer, 10)
  if (isNaN(choice) || choice < 1 || choice > toShow.length) {
    process.stderr.write(chalk.dim('Cancelled.\n'))
    process.exit(0)
  }

  const selected = toShow[choice - 1]
  process.stderr.write(chalk.green(`\nResuming session from ${selected.modified.toLocaleString()}...\n\n`))

  // Mark for the interactive session below to open this specific session
  cliFlags.continue = true
  cliFlags._selectedSessionPath = selected.path
}

// `gsd headless` — run auto-mode without TUI
if (cliFlags.messages[0] === 'headless') {
  await ensureRtkBootstrap()
  // Sync bundled resources before headless runs (#3471). Without this,
  // headless-query loads from src/resources/ while auto/interactive load
  // from ~/.gsd/agent/extensions/ — different extension copies diverge.
  initResources(agentDir)
  const { runHeadless, parseHeadlessArgs } = await import('./headless.js')
  await runHeadless(parseHeadlessArgs(process.argv))
  process.exit(0)
}

// `gsd auto [args...]` — shorthand for `gsd headless auto [args...]` (#2732)
// Without this, `gsd auto` falls through to the interactive TUI which hangs
// when stdin/stdout are piped (non-TTY environments).
if (cliFlags.messages[0] === 'auto') {
  await ensureRtkBootstrap()
  const { runHeadless, parseHeadlessArgs } = await import('./headless.js')
  // Rewrite argv so parseHeadlessArgs sees: [node, gsd, headless, auto, ...rest]
  const rewrittenArgv = [
    process.argv[0],
    process.argv[1],
    'headless',
    ...cliFlags.messages,   // ['auto', ...extra args]
  ]
  await runHeadless(parseHeadlessArgs(rewrittenArgv))
  process.exit(0)
}

// Pi's tool bootstrap can mis-detect already-installed fd/rg on some systems
// because spawnSync(..., ["--version"]) returns EPERM despite a zero exit code.
// Provision local managed binaries first so Pi sees them without probing PATH.
ensureManagedTools(join(agentDir, 'bin'))
markStartup('ensureManagedTools')

const authStorage = AuthStorage.create(authFilePath)
markStartup('AuthStorage.create')
loadStoredEnvKeys(authStorage)
migratePiCredentials(authStorage)

// Resolve models.json path with fallback to ~/.pi/agent/models.json
const { resolveModelsJsonPath } = await import('./models-resolver.js')
const modelsJsonPath = resolveModelsJsonPath()

const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath)
markStartup('ModelRegistry')
const settingsManager = SettingsManager.create(agentDir)
applySecurityOverrides(settingsManager)
markStartup('SettingsManager.create')

// Run onboarding wizard on first launch (no LLM provider configured)
if (!isPrintMode && shouldRunOnboarding(authStorage, settingsManager.getDefaultProvider())) {
  await runOnboarding(authStorage)

  // Clean up stdin state left by @clack/prompts.
  // readline.emitKeypressEvents() adds a permanent data listener and
  // readline.createInterface() may leave stdin paused. Remove stale
  // listeners and pause stdin so the TUI can start with a clean slate.
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.setRawMode) process.stdin.setRawMode(false)
  process.stdin.pause()
}

// Update check — non-blocking banner check; interactive prompt deferred to avoid
// blocking startup. The passive checkForUpdates() prints a banner if an update is
// available (using cached data or a background fetch) without blocking the TUI.
if (!isPrintMode) {
  checkForUpdates().catch(() => {})
}

// Warn if terminal is too narrow for readable output
if (!isPrintMode && process.stdout.columns && process.stdout.columns < 40) {
  process.stderr.write(
    chalk.yellow(`[gsd] Terminal width is ${process.stdout.columns} columns (minimum recommended: 40). Output may be unreadable.\n`),
  )
}

// --list-models: print available models and exit (no TTY needed)
if (cliFlags.listModels !== undefined) {
  const models = modelRegistry.getAvailable()
  if (models.length === 0) {
    console.log('No models available. Set API keys in environment variables.')
    process.exit(0)
  }

  const searchPattern = typeof cliFlags.listModels === 'string' ? cliFlags.listModels : undefined
  let filtered = models
  if (searchPattern) {
    const q = searchPattern.toLowerCase()
    filtered = models.filter((m) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q))
  }

  // Sort by name descending (newest first), then provider, then id
  filtered.sort((a, b) => {
    const nameCmp = b.name.localeCompare(a.name)
    if (nameCmp !== 0) return nameCmp
    const provCmp = a.provider.localeCompare(b.provider)
    if (provCmp !== 0) return provCmp
    return a.id.localeCompare(b.id)
  })

  const fmt = (n: number) => n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1_000 ? `${n / 1_000}K` : `${n}`
  const rows = filtered.map((m) => [
    m.provider,
    m.id,
    m.name,
    fmt(m.contextWindow),
    fmt(m.maxTokens),
    m.reasoning ? 'yes' : 'no',
  ])
  const hdrs = ['provider', 'model', 'name', 'context', 'max-out', 'thinking']
  const widths = hdrs.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const pad = (s: string, w: number) => s.padEnd(w)
  console.log(hdrs.map((h, i) => pad(h, widths[i])).join('  '))
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '))
  }
  process.exit(0)
}

// GSD always uses quiet startup — the gsd extension renders its own branded header
if (!settingsManager.getQuietStartup()) {
  settingsManager.setQuietStartup(true)
}

// Collapse changelog by default — avoid wall of text on updates
if (!settingsManager.getCollapseChangelog()) {
  settingsManager.setCollapseChangelog(true)
}

// ---------------------------------------------------------------------------
// Print / subagent mode — single-shot execution, no TTY required
// ---------------------------------------------------------------------------
if (isPrintMode) {
  await ensureRtkBootstrap()
  const sessionManager = cliFlags.noSession
    ? SessionManager.inMemory()
    : SessionManager.create(process.cwd())

  // Read --append-system-prompt file content (subagent writes agent system prompts to temp files)
  let appendSystemPrompt: string | undefined
  if (cliFlags.appendSystemPrompt) {
    try {
      appendSystemPrompt = readFileSync(cliFlags.appendSystemPrompt, 'utf-8')
    } catch {
      // If it's not a file path, treat it as literal text
      appendSystemPrompt = cliFlags.appendSystemPrompt
    }
  }

  exitIfManagedResourcesAreNewer(agentDir)
  initResources(agentDir)
  markStartup('initResources')
  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
    appendSystemPrompt,
  })
  await resourceLoader.reload()
  markStartup('resourceLoader.reload')

  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
  })
  markStartup('createAgentSession')

  // Validate configured model AFTER extensions have registered their models (#2626).
  // Before this, extension-provided models (e.g. claude-code/*) were not yet in the
  // registry, causing the user's valid choice to be silently overwritten.
  validateConfiguredModel(modelRegistry, settingsManager)

  // Re-apply the validated model to the session only when findInitialModel() used a
  // fallback (not when restoring an existing session's model). This prevents silently
  // overriding the persisted model of resumed conversations (#3534).
  if (modelFallbackMessage) {
    const validatedProvider = settingsManager.getDefaultProvider()
    const validatedModelId = settingsManager.getDefaultModel()
    if (validatedProvider && validatedModelId) {
      const correctModel = modelRegistry.getAvailable()
        .find((m) => m.provider === validatedProvider && m.id === validatedModelId)
      if (correctModel) {
        try {
          await session.setModel(correctModel)
        } catch {
          // Provider not ready — leave session on its current model
        }
      }
    }
  }

  if (extensionsResult.errors.length > 0) {
    for (const err of extensionsResult.errors) {
      // Downgrade conflicts with built-in tools to warnings (#1347)
      const isConflict = err.error.includes("supersedes") || err.error.includes("conflicts with");
      const prefix = isConflict ? "Extension conflict" : "Extension load error";
      process.stderr.write(`[gsd] ${prefix}: ${err.error}\n`)
    }
  }

  // Apply --model override if specified
  if (cliFlags.model) {
    const available = modelRegistry.getAvailable()
    const match =
      available.find((m) => m.id === cliFlags.model) ||
      available.find((m) => `${m.provider}/${m.id}` === cliFlags.model)
    if (match) {
      session.setModel(match)
    }
  }

  const mode = cliFlags.mode || 'text'

  if (mode === 'rpc') {
    printStartupTimings()
    await runRpcMode(session)
    process.exit(0)
  }

  if (mode === 'mcp') {
    printStartupTimings()
    const { startMcpServer } = await import('./mcp-server.js')
    await startMcpServer({
      tools: session.agent.state.tools ?? [],
      version: process.env.GSD_VERSION || '0.0.0',
    })
    // MCP server runs until the transport closes; keep alive
    await new Promise(() => {})
  }

  printStartupTimings()
  await runPrintMode(session, {
    mode: mode as 'text' | 'json',
    messages: cliFlags.messages,
  })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Worktree subcommand — `gsd worktree <list|merge|clean|remove>`
// ---------------------------------------------------------------------------
if (cliFlags.messages[0] === 'worktree' || cliFlags.messages[0] === 'wt') {
  const { handleList, handleMerge, handleClean, handleRemove } = await import('./worktree-cli.js')
  const sub = cliFlags.messages[1]
  const subArgs = cliFlags.messages.slice(2)

  if (!sub || sub === 'list') {
    await handleList(process.cwd())
  } else if (sub === 'merge') {
    await handleMerge(process.cwd(), subArgs)
  } else if (sub === 'clean') {
    await handleClean(process.cwd())
  } else if (sub === 'remove' || sub === 'rm') {
    await handleRemove(process.cwd(), subArgs)
  } else {
    process.stderr.write(`Unknown worktree command: ${sub}\n`)
    process.stderr.write('Commands: list, merge [name], clean, remove <name>\n')
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Worktree flag (-w) — create/resume a worktree for the interactive session
// ---------------------------------------------------------------------------
if (cliFlags.worktree) {
  const { handleWorktreeFlag } = await import('./worktree-cli.js')
  await handleWorktreeFlag(cliFlags.worktree)
}

// ---------------------------------------------------------------------------
// Active worktree banner — remind user of unmerged worktrees on normal launch
// ---------------------------------------------------------------------------
if (!cliFlags.worktree && !isPrintMode) {
  try {
    const { handleStatusBanner } = await import('./worktree-cli.js')
    await handleStatusBanner(process.cwd())
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Auto-redirect: `gsd auto` with piped stdout → headless mode (#2732)
// When stdout is not a TTY (e.g. `gsd auto | cat`, `gsd auto > file`),
// the TUI cannot render and the process hangs. Redirect to headless mode
// which handles non-interactive output gracefully.
// ---------------------------------------------------------------------------
if (cliFlags.messages[0] === 'auto' && !process.stdout.isTTY) {
  await ensureRtkBootstrap()
  const { runHeadless, parseHeadlessArgs } = await import('./headless.js')
  process.stderr.write('[gsd] stdout is not a terminal — running auto-mode in headless mode.\n')
  await runHeadless(parseHeadlessArgs(['node', 'gsd', 'headless', ...cliFlags.messages.slice(1)]))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Interactive mode — normal TTY session
// ---------------------------------------------------------------------------

await ensureRtkBootstrap()

// Per-directory session storage — same encoding as the upstream SDK so that
// /resume only shows sessions from the current working directory.
const cwd = process.cwd()
const projectSessionsDir = getProjectSessionsDir(cwd)

// Migrate legacy flat sessions: before per-directory scoping, all .jsonl session
// files lived directly in ~/.gsd/sessions/. Move them into the correct per-cwd
// subdirectory so /resume can find them.
migrateLegacyFlatSessions(sessionsDir, projectSessionsDir)

const sessionManager = cliFlags._selectedSessionPath
  ? SessionManager.open(cliFlags._selectedSessionPath, projectSessionsDir)
  : cliFlags.continue
    ? SessionManager.continueRecent(cwd, projectSessionsDir)
    : SessionManager.create(cwd, projectSessionsDir)

exitIfManagedResourcesAreNewer(agentDir)
initResources(agentDir)
markStartup('initResources')

// Overlap resource loading with session manager setup — both are independent.
// resourceLoader.reload() is the most expensive step (jiti compilation), so
// starting it early shaves ~50-200ms off interactive startup.
const resourceLoader = buildResourceLoader(agentDir)
const resourceLoadPromise = resourceLoader.reload()

// While resources load, let session manager finish any async I/O it needs.
// Then await the resource promise before creating the agent session.
await resourceLoadPromise
markStartup('resourceLoader.reload')

const { session, extensionsResult, modelFallbackMessage: interactiveFallbackMsg } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
})
markStartup('createAgentSession')

// Validate configured model AFTER extensions have registered their models (#2626).
// Before this, extension-provided models (e.g. claude-code/*) were not yet in the
// registry, causing the user's valid choice to be silently overwritten.
validateConfiguredModel(modelRegistry, settingsManager)

// Re-apply the validated model to the session only when findInitialModel() used a
// fallback (not when restoring an existing session's model). This prevents silently
// overriding the persisted model of resumed conversations (#3534).
if (interactiveFallbackMsg) {
  const validatedProvider = settingsManager.getDefaultProvider()
  const validatedModelId = settingsManager.getDefaultModel()
  if (validatedProvider && validatedModelId) {
    const correctModel = modelRegistry.getAvailable()
      .find((m) => m.provider === validatedProvider && m.id === validatedModelId)
    if (correctModel) {
      try {
        await session.setModel(correctModel)
      } catch {
        // Provider not ready — leave session on its current model
      }
    }
  }
}

if (extensionsResult.errors.length > 0) {
  for (const err of extensionsResult.errors) {
    const isConflict = err.error.includes("supersedes") || err.error.includes("conflicts with");
    const prefix = isConflict ? "Extension conflict" : "Extension load error";
    process.stderr.write(`[gsd] ${prefix}: ${err.error}\n`)
  }
}

// Restore scoped models from settings on startup.
// The upstream InteractiveMode reads enabledModels from settings when /scoped-models is opened,
// but doesn't apply them to the session at startup — so Ctrl+P cycles all models instead of
// just the saved selection until the user re-runs /scoped-models.
const enabledModelPatterns = settingsManager.getEnabledModels()
if (enabledModelPatterns && enabledModelPatterns.length > 0) {
  const availableModels = modelRegistry.getAvailable()
  const scopedModels: Array<{ model: (typeof availableModels)[number] }> = []
  const seen = new Set<string>()

  for (const pattern of enabledModelPatterns) {
    // Patterns are "provider/modelId" exact strings saved by /scoped-models
    const slashIdx = pattern.indexOf('/')
    if (slashIdx !== -1) {
      const provider = pattern.substring(0, slashIdx)
      const modelId = pattern.substring(slashIdx + 1)
      const model = availableModels.find((m) => m.provider === provider && m.id === modelId)
      if (model) {
        const key = `${model.provider}/${model.id}`
        if (!seen.has(key)) {
          seen.add(key)
          scopedModels.push({ model })
        }
      }
    } else {
      // Fallback: match by model id alone
      const model = availableModels.find((m) => m.id === pattern)
      if (model) {
        const key = `${model.provider}/${model.id}`
        if (!seen.has(key)) {
          seen.add(key)
          scopedModels.push({ model })
        }
      }
    }
  }

  // Only apply if we resolved some models and it's a genuine subset
  if (scopedModels.length > 0 && scopedModels.length < availableModels.length) {
    session.setScopedModels(scopedModels)
  }
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  const missing = !process.stdin.isTTY && !process.stdout.isTTY
    ? 'stdin and stdout are'
    : !process.stdin.isTTY
      ? 'stdin is'
      : 'stdout is'
  process.stderr.write(`[gsd] Error: Interactive mode requires a terminal (TTY) but ${missing} not a TTY.\n`)
  process.stderr.write('[gsd] Non-interactive alternatives:\n')
  process.stderr.write('[gsd]   gsd auto                       Auto-mode (pipeable, no TUI)\n')
  process.stderr.write('[gsd]   gsd --print "your message"     Single-shot prompt\n')
  process.stderr.write('[gsd]   gsd --web [path]               Browser-only web mode\n')
  process.stderr.write('[gsd]   gsd --mode rpc                 JSON-RPC over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode mcp                 MCP server over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode text "message"      Text output mode\n')
  process.stderr.write('[gsd]   gsd headless                   Auto-mode without TUI\n')
  process.exit(1)
}

// Welcome screen — shown on every fresh interactive session before TUI takes over.
// Skip when the first-run banner was already printed in loader.ts (prevents double banner).
if (!process.env.GSD_FIRST_RUN_BANNER) {
  const { printWelcomeScreen } = await import('./welcome-screen.js')
  let remoteChannel: string | undefined
  try {
    const { resolveRemoteConfig } = await import('./resources/extensions/remote-questions/config.js')
    const rc = resolveRemoteConfig()
    if (rc) remoteChannel = rc.channel
  } catch { /* non-fatal */ }
  printWelcomeScreen({
    version: process.env.GSD_VERSION || '0.0.0',
    modelName: settingsManager.getDefaultModel() || undefined,
    provider: settingsManager.getDefaultProvider() || undefined,
    remoteChannel,
  })
}

const interactiveMode = new InteractiveMode(session)
markStartup('InteractiveMode')
printStartupTimings()
await interactiveMode.run()
