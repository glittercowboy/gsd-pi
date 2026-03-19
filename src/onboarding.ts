/**
 * Unified first-run onboarding wizard.
 *
 * Replaces the raw API-key-only wizard with a branded, clack-based experience
 * that guides users through LLM provider authentication before the TUI launches.
 *
 * Flow: logo -> choose LLM provider -> authenticate (OAuth or API key) ->
 *       optional tool keys -> summary -> TUI launches.
 *
 * All steps are skippable. All errors are recoverable. Never crashes boot.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuthStorage } from '@gsd/pi-coding-agent'
import { renderLogo } from './logo.js'
import { agentDir } from './app-paths.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolKeyConfig {
  provider: string
  envVar: string
  label: string
  hint: string
}

type ClackModule = typeof import('@clack/prompts')
type PicoModule = {
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
  dim: (s: string) => string
  bold: (s: string) => string
  red: (s: string) => string
  reset: (s: string) => string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL_KEYS: ToolKeyConfig[] = [
  {
    provider: 'context7',
    envVar: 'CONTEXT7_API_KEY',
    label: 'Context7',
    hint: 'up-to-date library docs',
  },
  {
    provider: 'jina',
    envVar: 'JINA_API_KEY',
    label: 'Jina AI',
    hint: 'clean web page extraction',
  },
  {
    provider: 'groq',
    envVar: 'GROQ_API_KEY',
    label: 'Groq',
    hint: 'voice transcription — free at console.groq.com',
  },
]

/** Known LLM provider IDs that, if authed, mean the user doesn't need onboarding */
const LLM_PROVIDER_IDS = [
  'anthropic',
  'anthropic-vertex',
  'openai',
  'github-copilot',
  'openai-codex',
  'google-gemini-cli',
  'google-antigravity',
  'google',
  'groq',
  'xai',
  'openrouter',
  'mistral',
  'ollama-cloud',
  'custom-openai',
]

/** API key prefix validation — loose checks to catch obvious mistakes */
const API_KEY_PREFIXES: Record<string, string[]> = {
  anthropic: ['sk-ant-'],
  openai: ['sk-'],
}

const OTHER_PROVIDERS = [
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'groq', label: 'Groq' },
  { value: 'xai', label: 'xAI (Grok)' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'ollama-cloud', label: 'Ollama Cloud' },
  { value: 'custom-openai', label: 'Custom (OpenAI-compatible)' },
]

// ─── Dynamic imports ──────────────────────────────────────────────────────────

/**
 * Dynamically import @clack/prompts and picocolors.
 * Dynamic import with fallback so the module doesn't crash if they're missing.
 */
async function loadClack(): Promise<ClackModule> {
  try {
    return await import('@clack/prompts')
  } catch {
    throw new Error('[gsd] @clack/prompts not found — onboarding wizard requires this dependency')
  }
}

async function loadPico(): Promise<PicoModule> {
  try {
    const mod = await import('picocolors')
    return mod.default ?? mod
  } catch {
    // Fallback: return identity functions
    const identity = (s: string) => s
    return { cyan: identity, green: identity, yellow: identity, dim: identity, bold: identity, red: identity, reset: identity }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Open a URL in the system browser (best-effort, non-blocking) */
function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {})
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}

/** Check if an error is a clack cancel signal */
function isCancelError(p: ClackModule, err: unknown): boolean {
  return p.isCancel(err)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine if the onboarding wizard should run.
 *
 * Returns true when:
 * - No LLM provider auth is available
 * - We're on a TTY (interactive terminal)
 *
 * Returns false (skip wizard) when:
 * - Any LLM provider is already available via auth.json, env vars, runtime overrides, or fallback auth
 * - A default provider is already configured in settings (covers extension-based providers
 *   that may not require credentials in auth.json)
 * - Not a TTY (piped input, subagent, CI)
 */
export function shouldRunOnboarding(authStorage: AuthStorage, settingsDefaultProvider?: string): boolean {
  if (!process.stdin.isTTY) return false
  if (settingsDefaultProvider) return false
  // Check if any LLM provider has credentials
  const hasLlmAuth = LLM_PROVIDER_IDS.some(id => authStorage.hasAuth(id))
  return !hasLlmAuth
}

/**
 * Run the unified onboarding wizard.
 *
 * Walks the user through:
 * 1. Choose LLM provider
 * 2. Authenticate (OAuth or API key)
 * 3. Optional tool API keys
 * 4. Summary
 *
 * All steps are skippable. All errors are recoverable.
 * Writes status to stderr during execution.
 */
export async function runOnboarding(authStorage: AuthStorage): Promise<void> {
  let p: ClackModule
  let pc: PicoModule
  try {
    ;[p, pc] = await Promise.all([loadClack(), loadPico()])
  } catch (err) {
    // If clack isn't available, fall back silently — don't block boot
    process.stderr.write(`[gsd] Onboarding wizard unavailable: ${err instanceof Error ? err.message : String(err)}\n`)
    return
  }

  // ── Intro ─────────────────────────────────────────────────────────────────
  process.stderr.write(renderLogo(pc.cyan))
  p.intro(pc.bold('Welcome to GSD — let\'s get you set up'))

  // ── LLM Provider Selection ────────────────────────────────────────────────
  let llmConfigured = false
  try {
    llmConfigured = await runLlmStep(p, pc, authStorage)
  } catch (err) {
    // User cancelled (Ctrl+C in clack throws) or unexpected error
    if (isCancelError(p, err)) {
      p.cancel('Setup cancelled — you can run /login inside GSD later.')
      return
    }
    p.log.warn(`LLM setup failed: ${err instanceof Error ? err.message : String(err)}`)
    p.log.info('You can configure your LLM provider later with /login inside GSD.')
  }

  // ── Web Search Provider ──────────────────────────────────────────────────
  let searchConfigured: string | null = null
  try {
    searchConfigured = await runWebSearchStep(p, pc, authStorage, llmConfigured)
  } catch (err) {
    if (isCancelError(p, err)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Web search setup failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Remote Questions ─────────────────────────────────────────────────────
  let remoteConfigured: string | null = null
  try {
    remoteConfigured = await runRemoteQuestionsStep(p, pc, authStorage)
  } catch (err) {
    if (isCancelError(p, err)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Remote questions setup failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Tool API Keys ─────────────────────────────────────────────────────────
  let toolKeyCount = 0
  try {
    toolKeyCount = await runToolKeysStep(p, pc, authStorage)
  } catch (err) {
    if (isCancelError(p, err)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Tool key setup failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryLines: string[] = []
  if (llmConfigured) {
    // Re-read what provider was stored
    const authed = authStorage.list().filter(id => LLM_PROVIDER_IDS.includes(id))
    if (authed.length > 0) {
      const name = authed[0]
      summaryLines.push(`${pc.green('✓')} LLM provider: ${name}`)
    } else {
      summaryLines.push(`${pc.green('✓')} LLM provider configured`)
    }
  } else {
    summaryLines.push(`${pc.yellow('↷')} LLM provider: skipped — use /login inside GSD`)
  }

  if (searchConfigured) {
    summaryLines.push(`${pc.green('✓')} Web search: ${searchConfigured}`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Web search: not configured — use /search-provider inside GSD`)
  }

  if (remoteConfigured) {
    summaryLines.push(`${pc.green('✓')} Remote questions: ${remoteConfigured}`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Remote questions: not configured — use /gsd remote inside GSD`)
  }

  if (toolKeyCount > 0) {
    summaryLines.push(`${pc.green('✓')} ${toolKeyCount} tool key${toolKeyCount > 1 ? 's' : ''} saved`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Tool keys: none configured`)
  }

  p.note(summaryLines.join('\n'), 'Setup complete')
  p.outro(pc.dim('Launching GSD...'))
}

// ─── LLM Authentication Step ──────────────────────────────────────────────────

async function runLlmStep(p: ClackModule, pc: PicoModule, authStorage: AuthStorage): Promise<boolean> {
  // Build the OAuth provider list dynamically from what's registered
  const oauthProviders = authStorage.getOAuthProviders()
  const oauthMap = new Map(oauthProviders.map(op => [op.id, op]))

  // Check if already authenticated
  const existingAuth = LLM_PROVIDER_IDS.find(id => authStorage.hasAuth(id))

  // ── Step 1: How do you want to authenticate? ─────────────────────────────
  type AuthOption = { value: string; label: string; hint?: string }
  const authOptions: AuthOption[] = []

  if (existingAuth) {
    authOptions.push({ value: 'keep', label: `Keep current (${existingAuth})`, hint: 'already configured' })
  }

  authOptions.push(
    { value: 'browser', label: 'Sign in with your browser', hint: 'recommended — same login as claude.ai / ChatGPT' },
    { value: 'api-key', label: 'Paste an API key', hint: 'from your provider dashboard' },
    { value: 'skip', label: 'Skip for now', hint: 'use /login inside GSD later' },
  )

  const method = await p.select({
    message: existingAuth ? `LLM provider: ${existingAuth} — change it?` : 'How do you want to sign in?',
    options: authOptions,
  })

  if (p.isCancel(method) || method === 'skip') return false
  if (method === 'keep') return true

  // ── Step 2: Which provider? ──────────────────────────────────────────────
  if (method === 'browser') {
    const provider = await p.select({
      message: 'Choose provider',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'recommended' },
        { value: 'github-copilot', label: 'GitHub Copilot' },
        { value: 'openai-codex', label: 'ChatGPT Plus/Pro (Codex)' },
        { value: 'google-gemini-cli', label: 'Google Gemini CLI' },
        { value: 'google-antigravity', label: 'Antigravity (Gemini 3, Claude, GPT-OSS)' },
      ],
    })
    if (p.isCancel(provider)) return false
    return await runOAuthFlow(p, pc, authStorage, provider as string, oauthMap)
  }

  if (method === 'api-key') {
    const provider = await p.select({
      message: 'Choose provider',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)' },
        { value: 'openai', label: 'OpenAI' },
        ...OTHER_PROVIDERS.map(op => ({ value: op.value, label: op.label })),
      ],
    })
    if (p.isCancel(provider)) return false
    if (provider === 'custom-openai') {
      return await runCustomOpenAIFlow(p, pc, authStorage)
    }
    const label = provider === 'anthropic' ? 'Anthropic'
      : provider === 'openai' ? 'OpenAI'
      : OTHER_PROVIDERS.find(op => op.value === provider)?.label ?? String(provider)
    return await runApiKeyFlow(p, pc, authStorage, provider as string, label)
  }

  return false
}

// ─── OAuth Flow ───────────────────────────────────────────────────────────────

async function runOAuthFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  oauthMap: Map<string, { id: string; name?: string; usesCallbackServer?: boolean }>,
): Promise<boolean> {
  const providerInfo = oauthMap.get(providerId)
  const providerName = providerInfo?.name ?? providerId
  const usesCallbackServer = providerInfo?.usesCallbackServer ?? false

  const s = p.spinner()
  s.start(`Authenticating with ${providerName}...`)

  try {
    await authStorage.login(providerId as any, {
      onAuth: (info: { url: string; instructions?: string }) => {
        s.stop(`Opening browser for ${providerName}`)
        openBrowser(info.url)
        p.log.info(`${pc.dim('URL:')} ${pc.cyan(info.url)}`)
        if (info.instructions) {
          p.log.info(pc.yellow(info.instructions))
        }
      },
      onPrompt: async (prompt: { message: string; placeholder?: string }) => {
        const result = await p.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
        })
        if (p.isCancel(result)) return ''
        return result as string
      },
      onProgress: (message: string) => {
        p.log.step(pc.dim(message))
      },
      onManualCodeInput: usesCallbackServer
        ? async () => {
            const result = await p.text({
              message: 'Paste the redirect URL from your browser:',
              placeholder: 'http://localhost:...',
            })
            if (p.isCancel(result)) return ''
            return result as string
          }
        : undefined,
    } as any)

    p.log.success(`Authenticated with ${pc.green(providerName)}`)
    return true
  } catch (err) {
    s.stop(`${providerName} authentication failed`)
    const errorMsg = err instanceof Error ? err.message : String(err)
    p.log.warn(`OAuth error: ${errorMsg}`)

    // Offer retry or skip
    const retry = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'retry', label: 'Try again' },
        { value: 'skip', label: 'Skip — configure later with /login' },
      ],
    })

    if (p.isCancel(retry) || retry === 'skip') return false
    // Recursive retry
    return runOAuthFlow(p, pc, authStorage, providerId, oauthMap)
  }
}

// ─── API Key Flow ─────────────────────────────────────────────────────────────

async function runApiKeyFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  providerLabel: string,
): Promise<boolean> {
  const key = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: '●',
  })

  if (p.isCancel(key) || !key) return false
  const trimmed = (key as string).trim()
  if (!trimmed) return false

  // Basic prefix validation
  const expectedPrefixes = API_KEY_PREFIXES[providerId]
  if (expectedPrefixes && !expectedPrefixes.some(pfx => trimmed.startsWith(pfx))) {
    p.log.warn(`Key doesn't start with expected prefix (${expectedPrefixes.join(' or ')}). Saving anyway.`)
  }

  authStorage.set(providerId, { type: 'api_key', key: trimmed })
  p.log.success(`API key saved for ${pc.green(providerLabel)}`)
  return true
}

// ─── Custom OpenAI-compatible Flow ────────────────────────────────────────────

async function runCustomOpenAIFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<boolean> {
  // Prompt for base URL
  const baseUrl = await p.text({
    message: 'Base URL of your OpenAI-compatible endpoint:',
    placeholder: 'https://my-proxy.example.com/v1',
    validate: (val) => {
      const trimmed = val?.trim()
      if (!trimmed) return 'Base URL is required'
      try {
        new URL(trimmed)
      } catch {
        return 'Must be a valid URL (e.g. https://my-proxy.example.com/v1)'
      }
    },
  })
  if (p.isCancel(baseUrl) || !baseUrl) return false
  const trimmedUrl = (baseUrl as string).trim()

  // Prompt for API key
  const apiKey = await p.password({
    message: 'API key for this endpoint:',
    mask: '●',
  })
  if (p.isCancel(apiKey) || !apiKey) return false
  const trimmedKey = (apiKey as string).trim()
  if (!trimmedKey) return false

  // Prompt for model ID
  const modelId = await p.text({
    message: 'Model ID to use:',
    placeholder: 'gpt-4o',
    validate: (val) => {
      if (!val?.trim()) return 'Model ID is required'
    },
  })
  if (p.isCancel(modelId) || !modelId) return false
  const trimmedModelId = (modelId as string).trim()

  // Save API key to auth storage
  authStorage.set('custom-openai', { type: 'api_key', key: trimmedKey })

  // Write or merge into models.json
  const modelsJsonPath = join(agentDir, 'models.json')
  let config: { providers: Record<string, any> } = { providers: {} }

  if (existsSync(modelsJsonPath)) {
    try {
      config = JSON.parse(readFileSync(modelsJsonPath, 'utf-8'))
      if (!config.providers) config.providers = {}
    } catch {
      // If existing file is corrupt, start fresh
      config = { providers: {} }
    }
  }

  config.providers['custom-openai'] = {
    baseUrl: trimmedUrl,
    apiKey: `env:CUSTOM_OPENAI_API_KEY`,
    api: 'openai-completions',
    models: [
      {
        id: trimmedModelId,
        name: trimmedModelId,
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }

  // Ensure parent directory exists
  const dir = dirname(modelsJsonPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(modelsJsonPath, JSON.stringify(config, null, 2), 'utf-8')

  // Also set env var so the current session picks up the key via fallback resolver
  process.env.CUSTOM_OPENAI_API_KEY = trimmedKey

  p.log.success(`Custom endpoint saved: ${pc.green(trimmedUrl)}`)
  p.log.info(`Model: ${pc.cyan(trimmedModelId)}`)
  p.log.info(`Config written to ${pc.dim(modelsJsonPath)}`)
  return true
}

// ─── Web Search Provider Step ─────────────────────────────────────────────────

async function runWebSearchStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  isAnthropicAuth: boolean,
): Promise<string | null> {
  // Check which LLM provider was configured
  const authed = authStorage.list().filter(id => LLM_PROVIDER_IDS.includes(id))
  const isAnthropic = isAnthropicAuth && authed.includes('anthropic')

  // Check if web search is already configured
  const hasBrave = !!process.env.BRAVE_API_KEY || authStorage.has('brave')
  const hasTavily = !!process.env.TAVILY_API_KEY || authStorage.has('tavily')
  const existingSearch = hasBrave ? 'Brave Search' : hasTavily ? 'Tavily' : null

  // Build options based on what's available
  type SearchOption = { value: string; label: string; hint?: string }
  const options: SearchOption[] = []

  if (existingSearch) {
    options.push({ value: 'keep', label: `Keep current (${existingSearch})`, hint: 'already configured' })
  }

  if (isAnthropic) {
    options.push({
      value: 'anthropic-native',
      label: 'Anthropic built-in web search',
      hint: 'no API key needed — already included with Claude',
    })
  }

  options.push(
    { value: 'brave', label: 'Brave Search', hint: 'requires API key — brave.com/search/api' },
    { value: 'tavily', label: 'Tavily', hint: 'requires API key — tavily.com' },
    { value: 'skip', label: 'Skip for now', hint: 'use /search-provider inside GSD later' },
  )

  const choice = await p.select({
    message: 'How do you want to search the web?',
    options,
  })

  if (p.isCancel(choice) || choice === 'skip') return null
  if (choice === 'keep') return existingSearch

  if (choice === 'anthropic-native') {
    p.log.success(`Web search: ${pc.green('Anthropic built-in')} — works out of the box`)
    return 'Anthropic built-in'
  }

  if (choice === 'brave') {
    const key = await p.password({
      message: `Paste your Brave Search API key ${pc.dim('(brave.com/search/api)')}:`,
      mask: '●',
    })
    if (p.isCancel(key) || !(key as string)?.trim()) return null
    const trimmed = (key as string).trim()
    authStorage.set('brave', { type: 'api_key', key: trimmed })
    process.env.BRAVE_API_KEY = trimmed
    p.log.success(`Web search: ${pc.green('Brave Search')} configured`)
    return 'Brave Search'
  }

  if (choice === 'tavily') {
    const key = await p.password({
      message: `Paste your Tavily API key ${pc.dim('(tavily.com)')}:`,
      mask: '●',
    })
    if (p.isCancel(key) || !(key as string)?.trim()) return null
    const trimmed = (key as string).trim()
    authStorage.set('tavily', { type: 'api_key', key: trimmed })
    process.env.TAVILY_API_KEY = trimmed
    p.log.success(`Web search: ${pc.green('Tavily')} configured`)
    return 'Tavily'
  }

  return null
}

// ─── Tool API Keys Step ───────────────────────────────────────────────────────

async function runToolKeysStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<number> {
  // Filter to keys not already configured
  const missing = TOOL_KEYS.filter(tk => !authStorage.has(tk.provider) && !process.env[tk.envVar])
  if (missing.length === 0) return 0

  const wantToolKeys = await p.confirm({
    message: 'Set up optional tool API keys? (web search, docs, etc.)',
    initialValue: false,
  })

  if (p.isCancel(wantToolKeys) || !wantToolKeys) return 0

  let savedCount = 0
  for (const tk of missing) {
    const key = await p.password({
      message: `${tk.label} ${pc.dim(`(${tk.hint})`)} — Enter to skip:`,
      mask: '●',
    })

    if (p.isCancel(key)) break

    const trimmed = (key as string | undefined)?.trim()
    if (trimmed) {
      authStorage.set(tk.provider, { type: 'api_key', key: trimmed })
      process.env[tk.envVar] = trimmed
      p.log.success(`${tk.label} saved`)
      savedCount++
    } else {
      // Store empty key so wizard doesn't re-ask on next launch
      authStorage.set(tk.provider, { type: 'api_key', key: '' })
      p.log.info(pc.dim(`${tk.label} skipped`))
    }
  }

  return savedCount
}

// ─── Remote Questions Step ────────────────────────────────────────────────────

async function runRemoteQuestionsStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<string | null> {
  // Check existing config
  const hasDiscord = authStorage.has('discord_bot') && !!(authStorage.get('discord_bot') as any)?.key
  const hasSlack = authStorage.has('slack_bot') && !!(authStorage.get('slack_bot') as any)?.key
  const hasTelegram = authStorage.has('telegram_bot') && !!(authStorage.get('telegram_bot') as any)?.key
  const existingChannel = hasDiscord ? 'Discord' : hasSlack ? 'Slack' : hasTelegram ? 'Telegram' : null

  type RemoteOption = { value: string; label: string; hint?: string }
  const options: RemoteOption[] = []

  if (existingChannel) {
    options.push({ value: 'keep', label: `Keep current (${existingChannel})`, hint: 'already configured' })
  }

  options.push(
    { value: 'discord', label: 'Discord', hint: 'receive questions in a Discord channel' },
    { value: 'slack', label: 'Slack', hint: 'receive questions in a Slack channel' },
    { value: 'telegram', label: 'Telegram', hint: 'receive questions via Telegram bot' },
    { value: 'skip', label: 'Skip for now', hint: 'use /gsd remote inside GSD later' },
  )

  const choice = await p.select({
    message: 'Set up remote questions? (get notified when GSD needs input)',
    options,
  })

  if (p.isCancel(choice) || choice === 'skip') return null
  if (choice === 'keep') return existingChannel

  if (choice === 'discord') {
    const token = await p.password({
      message: 'Paste your Discord bot token:',
      mask: '●',
    })
    if (p.isCancel(token) || !(token as string)?.trim()) return null
    const trimmed = (token as string).trim()

    authStorage.set('discord_bot', { type: 'api_key', key: trimmed })
    process.env.DISCORD_BOT_TOKEN = trimmed

    const channelName = await runDiscordChannelStep(p, pc, trimmed)
    return channelName ? `Discord #${channelName}` : 'Discord'
  }

  if (choice === 'slack') {
    const token = await p.password({
      message: `Paste your Slack bot token ${pc.dim('(xoxb-...)')}:`,
      mask: '●',
    })
    if (p.isCancel(token) || !(token as string)?.trim()) return null
    const trimmed = (token as string).trim()
    if (!trimmed.startsWith('xoxb-')) {
      p.log.warn('Invalid token format — Slack bot tokens start with xoxb-.')
      return null
    }

    // Validate
    const s = p.spinner()
    s.start('Validating Slack token...')
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: AbortSignal.timeout(15_000),
      })
      const data = await res.json() as any
      if (!data?.ok) {
        s.stop('Slack token validation failed')
        return null
      }
      s.stop(`Slack authenticated as ${pc.green(data.user ?? 'bot')}`)
    } catch {
      s.stop('Could not reach Slack API')
      return null
    }

    authStorage.set('slack_bot', { type: 'api_key', key: trimmed })
    process.env.SLACK_BOT_TOKEN = trimmed

    const channelId = await p.text({
      message: 'Paste the Slack channel ID (e.g. C0123456789):',
      validate: (val) => {
        if (!val || !/^[A-Z0-9]{9,12}$/.test(val.trim())) return 'Expected 9-12 uppercase alphanumeric characters'
      },
    })
    if (p.isCancel(channelId) || !channelId) return null

    const { saveRemoteQuestionsConfig } = await import('./remote-questions-config.js')
    saveRemoteQuestionsConfig('slack', (channelId as string).trim())
    p.log.success(`Slack channel: ${pc.green((channelId as string).trim())}`)
    return 'Slack'
  }

  if (choice === 'telegram') {
    const token = await p.password({
      message: 'Paste your Telegram bot token (from @BotFather):',
      mask: '●',
    })
    if (p.isCancel(token) || !(token as string)?.trim()) return null
    const trimmed = (token as string).trim()
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) {
      p.log.warn('Invalid token format — Telegram bot tokens look like 123456789:ABCdefGHI...')
      return null
    }

    // Validate
    const s = p.spinner()
    s.start('Validating Telegram bot token...')
    try {
      const res = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
        signal: AbortSignal.timeout(15_000),
      })
      const data = await res.json() as any
      if (!data?.ok || !data?.result?.id) {
        s.stop('Telegram token validation failed')
        return null
      }
      s.stop(`Telegram bot: ${pc.green(data.result.first_name ?? data.result.username ?? 'bot')}`)
    } catch {
      s.stop('Could not reach Telegram API')
      return null
    }

    authStorage.set('telegram_bot', { type: 'api_key', key: trimmed })
    process.env.TELEGRAM_BOT_TOKEN = trimmed

    const chatId = await p.text({
      message: 'Paste the Telegram chat ID (e.g. -1001234567890):',
      validate: (val) => {
        if (!val || !/^-?\d{5,20}$/.test(val.trim())) return 'Expected a numeric chat ID (can be negative for groups)'
      },
    })
    if (p.isCancel(chatId) || !chatId) return null
    const trimmedChatId = (chatId as string).trim()

    // Test send
    const ts = p.spinner()
    ts.start('Testing message delivery...')
    try {
      const res = await fetch(`https://api.telegram.org/bot${trimmed}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: trimmedChatId, text: 'GSD remote questions connected.' }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = await res.json() as any
      if (!data?.ok) {
        ts.stop(`Could not send to chat: ${data?.description ?? 'unknown error'}`)
        return null
      }
      ts.stop('Test message sent')
    } catch {
      ts.stop('Could not reach Telegram API')
      return null
    }

    const { saveRemoteQuestionsConfig } = await import('./remote-questions-config.js')
    saveRemoteQuestionsConfig('telegram', trimmedChatId)
    p.log.success(`Telegram chat: ${pc.green(trimmedChatId)}`)
    return 'Telegram'
  }

  return null
}

async function runDiscordChannelStep(p: ClackModule, pc: PicoModule, token: string): Promise<string | null> {
  const headers = { Authorization: `Bot ${token}` }

  // Validate token
  const s = p.spinner()
  s.start('Validating Discord bot token...')
  let auth: any
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', { headers, signal: AbortSignal.timeout(15_000) })
    auth = await res.json()
  } catch {
    s.stop('Could not reach Discord API')
    return null
  }
  if (!auth?.id) {
    s.stop('Discord token validation failed')
    return null
  }
  s.stop(`Bot authenticated as ${pc.green(auth.username ?? 'unknown')}`)

  // Fetch guilds
  let guilds: Array<{ id: string; name: string }>
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers, signal: AbortSignal.timeout(15_000) })
    const data = await res.json()
    guilds = Array.isArray(data) ? data : []
  } catch {
    p.log.warn('Could not fetch Discord servers — configure channel later with /gsd remote discord')
    return null
  }

  if (guilds.length === 0) {
    p.log.warn('Bot is not in any Discord servers — configure channel later with /gsd remote discord')
    return null
  }

  // Select guild
  let guildId: string
  let guildName: string
  if (guilds.length === 1) {
    guildId = guilds[0].id
    guildName = guilds[0].name
    p.log.info(`Server: ${pc.green(guildName)}`)
  } else {
    const choice = await p.select({
      message: 'Which Discord server?',
      options: guilds.map(g => ({ value: g.id, label: g.name })),
    })
    if (p.isCancel(choice)) return null
    guildId = choice as string
    guildName = guilds.find(g => g.id === guildId)?.name ?? guildId
  }

  // Fetch channels
  let channels: Array<{ id: string; name: string; type: number }>
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers, signal: AbortSignal.timeout(15_000) })
    const data = await res.json()
    channels = Array.isArray(data) ? data.filter((ch: any) => ch.type === 0 || ch.type === 5) : []
  } catch {
    p.log.warn('Could not fetch channels — configure later with /gsd remote discord')
    return null
  }

  if (channels.length === 0) {
    p.log.warn('No text channels found — configure later with /gsd remote discord')
    return null
  }

  // Select channel
  const MANUAL_VALUE = '__manual__'
  const channelChoice = await p.select({
    message: 'Which channel should GSD use for remote questions?',
    options: [
      ...channels.map(ch => ({ value: ch.id, label: `#${ch.name}` })),
      { value: MANUAL_VALUE, label: 'Enter channel ID manually' },
    ],
  })
  if (p.isCancel(channelChoice)) return null

  let channelId: string
  if (channelChoice === MANUAL_VALUE) {
    const manualId = await p.text({
      message: 'Paste the Discord channel ID:',
      placeholder: '1234567890123456789',
      validate: (val) => {
        if (!val || !/^\d{17,20}$/.test(val.trim())) return 'Expected 17-20 digit numeric ID'
      },
    })
    if (p.isCancel(manualId) || !manualId) return null
    channelId = (manualId as string).trim()
  } else {
    channelId = channelChoice as string
  }

  // Save remote questions config
  const { saveRemoteQuestionsConfig } = await import('./remote-questions-config.js')
  saveRemoteQuestionsConfig('discord', channelId)
  const channelName = channels.find(ch => ch.id === channelId)?.name
  p.log.success(`Discord channel: ${pc.green(channelName ? `#${channelName}` : channelId)}`)
  return channelName ?? null
}

