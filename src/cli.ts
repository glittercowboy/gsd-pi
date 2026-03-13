import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
  InteractiveMode,
  runPrintMode,
  runRpcMode,
} from '@mariozechner/pi-coding-agent'
import { existsSync, readdirSync, renameSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, sessionsDir, authFilePath } from './app-paths.js'
import { initResources, buildResourceLoader } from './resource-loader.js'
import { ensureManagedTools } from './tool-bootstrap.js'
import { loadStoredEnvKeys } from './wizard.js'
import { migratePiCredentials } from './pi-migration.js'
import { shouldRunOnboarding, runOnboarding } from './onboarding.js'

// ---------------------------------------------------------------------------
// Minimal CLI arg parser — detects print/subagent mode flags
// ---------------------------------------------------------------------------
interface CliFlags {
  mode?: 'text' | 'json' | 'rpc'
  print?: boolean
  noSession?: boolean
  model?: string
  extensions: string[]
  appendSystemPrompt?: string
  tools?: string[]
  messages: string[]
}

function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { extensions: [], messages: [] }
  const args = argv.slice(2) // skip node + script
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode' && i + 1 < args.length) {
      const m = args[++i]
      if (m === 'text' || m === 'json' || m === 'rpc') flags.mode = m
    } else if (arg === '--print' || arg === '-p') {
      flags.print = true
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
    } else if (arg === '--version' || arg === '-v') {
      process.stdout.write((process.env.GSD_VERSION || '0.0.0') + '\n')
      process.exit(0)
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`GSD v${process.env.GSD_VERSION || '0.0.0'} — Get Shit Done\n\n`)
      process.stdout.write('Usage: gsd [options] [message...]\n\n')
      process.stdout.write('Options:\n')
      process.stdout.write('  --mode <text|json|rpc>   Output mode (default: interactive)\n')
      process.stdout.write('  --print, -p              Single-shot print mode\n')
      process.stdout.write('  --model <id>             Override model (e.g. claude-opus-4-6)\n')
      process.stdout.write('  --no-session             Disable session persistence\n')
      process.stdout.write('  --extension <path>       Load additional extension\n')
      process.stdout.write('  --tools <a,b,c>          Restrict available tools\n')
      process.stdout.write('  --version, -v            Print version and exit\n')
      process.stdout.write('  --help, -h               Print this help and exit\n')
      process.stdout.write('\nSubcommands:\n')
      process.stdout.write('  config                   Re-run the setup wizard\n')
      process.exit(0)
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      flags.messages.push(arg)
    }
  }
  return flags
}

const cliFlags = parseCliArgs(process.argv)
const isPrintMode = cliFlags.print || cliFlags.mode !== undefined

// `gsd config` — replay the setup wizard and exit
if (cliFlags.messages[0] === 'config') {
  const authStorage = AuthStorage.create(authFilePath)
  await runOnboarding(authStorage)
  process.exit(0)
}

// Pi's tool bootstrap can mis-detect already-installed fd/rg on some systems
// because spawnSync(..., ["--version"]) returns EPERM despite a zero exit code.
// Provision local managed binaries first so Pi sees them without probing PATH.
ensureManagedTools(join(agentDir, 'bin'))

const authStorage = AuthStorage.create(authFilePath)
loadStoredEnvKeys(authStorage)
migratePiCredentials(authStorage)

// Run onboarding wizard on first launch (no LLM provider configured)
if (!isPrintMode && shouldRunOnboarding(authStorage)) {
  await runOnboarding(authStorage)
}

const modelRegistry = new ModelRegistry(authStorage)

// Surface models.json parse errors as a warning — don't crash, the SDK
// falls back to built-in models gracefully.
const modelsJsonError = modelRegistry.getError()
if (modelsJsonError) {
  console.error(`[gsd] Warning: models.json error — ${modelsJsonError}`)
  console.error('[gsd] Custom provider models were not loaded. Built-in models are still available.')
}

// Auto-apply provider base URL overrides from environment variables.
// Matches the convention used by Claude Code, Aider, and the Anthropic SDK itself.
const ENV_OVERRIDES: Array<[string, string, string]> = [
  ['anthropic', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
  ['openai',    'OPENAI_BASE_URL',    'OPENAI_API_KEY'],
]
for (const [provider, baseUrlEnv, apiKeyEnv] of ENV_OVERRIDES) {
  const baseUrl = process.env[baseUrlEnv]
  const apiKey  = process.env[apiKeyEnv]
  if (baseUrl || apiKey) {
    modelRegistry.registerProvider(provider, { ...(baseUrl && { baseUrl }), ...(apiKey && { apiKey }) })
  }
}

const settingsManager = SettingsManager.create(agentDir)

// Validate configured model on startup — catches stale settings from prior installs
// (e.g. grok-2 which no longer exists) and fresh installs with no settings.
// Only resets the default when the configured model no longer exists in the registry;
// never overwrites a valid user choice.
const configuredProvider = settingsManager.getDefaultProvider()
const configuredModel = settingsManager.getDefaultModel()
const allModels = modelRegistry.getAll()
const configuredExists = configuredProvider && configuredModel &&
  allModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)

if (!configuredModel || !configuredExists) {
  // Fallback: try Anthropic first (preserves existing behavior for most users),
  // then any available model (supports custom-provider-only setups).
  const available = modelRegistry.getAvailable()
  const preferred =
    available.find((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-6') ||
    available.find((m) => m.provider === 'anthropic' && m.id.includes('opus')) ||
    available.find((m) => m.provider === 'anthropic') ||
    available[0]  // any available model — custom providers included
  if (preferred) {
    settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id)
  }
}

// Default thinking level: off (always reset if not explicitly set)
if (settingsManager.getDefaultThinkingLevel() !== 'off' && !configuredExists) {
  settingsManager.setDefaultThinkingLevel('off')
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

  initResources(agentDir)
  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
    appendSystemPrompt,
  })
  await resourceLoader.reload()

  const { session, extensionsResult } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
  })

  if (extensionsResult.errors.length > 0) {
    for (const err of extensionsResult.errors) {
      process.stderr.write(`[gsd] Extension load error: ${err.error}\n`)
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
    await runRpcMode(session)
    process.exit(0)
  }

  await runPrintMode(session, {
    mode,
    messages: cliFlags.messages,
  })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Interactive mode — normal TTY session
// ---------------------------------------------------------------------------

// Per-directory session storage — same encoding as the upstream SDK so that
// /resume only shows sessions from the current working directory.
const cwd = process.cwd()
const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
const projectSessionsDir = join(sessionsDir, safePath)

// Migrate legacy flat sessions: before per-directory scoping, all .jsonl session
// files lived directly in ~/.gsd/sessions/. Move them into the correct per-cwd
// subdirectory so /resume can find them.
if (existsSync(sessionsDir)) {
  try {
    const entries = readdirSync(sessionsDir)
    const flatJsonl = entries.filter(f => f.endsWith('.jsonl'))
    if (flatJsonl.length > 0) {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(projectSessionsDir, { recursive: true })
      for (const file of flatJsonl) {
        const src = join(sessionsDir, file)
        const dst = join(projectSessionsDir, file)
        if (!existsSync(dst)) {
          renameSync(src, dst)
        }
      }
    }
  } catch {
    // Non-fatal — don't block startup if migration fails
  }
}

const sessionManager = SessionManager.create(cwd, projectSessionsDir)

initResources(agentDir)
const resourceLoader = buildResourceLoader(agentDir)
await resourceLoader.reload()

const { session, extensionsResult } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
})

if (extensionsResult.errors.length > 0) {
  for (const err of extensionsResult.errors) {
    process.stderr.write(`[gsd] Extension load error: ${err.error}\n`)
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

if (!process.stdin.isTTY) {
  process.stderr.write('[gsd] Error: Interactive mode requires a terminal (TTY).\n')
  process.stderr.write('[gsd] Non-interactive alternatives:\n')
  process.stderr.write('[gsd]   gsd --print "your message"     Single-shot prompt\n')
  process.stderr.write('[gsd]   gsd --mode rpc                 JSON-RPC over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode text "message"      Text output mode\n')
  process.exit(1)
}

const interactiveMode = new InteractiveMode(session)
await interactiveMode.run()
