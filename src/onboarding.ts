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

import { exec } from 'node:child_process'
import type { AuthStorage } from '@gsd/pi-coding-agent'
import { renderLogo } from './logo.js'

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
    provider: 'slack_bot',
    envVar: 'SLACK_BOT_TOKEN',
    label: 'Slack Bot',
    hint: 'remote questions in auto-mode',
  },
  {
    provider: 'discord_bot',
    envVar: 'DISCORD_BOT_TOKEN',
    label: 'Discord Bot',
    hint: 'remote questions in auto-mode',
  },
]

/** Known LLM provider IDs that, if authed, mean the user doesn't need onboarding */
const LLM_PROVIDER_IDS = [
  'anthropic',
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
  const cmd = process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' :
      'xdg-open'
  exec(`${cmd} "${url}"`, () => {
    // Ignore errors — user can manually open the URL
  })
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
 * - Not a TTY (piped input, subagent, CI)
 */
export function shouldRunOnboarding(authStorage: AuthStorage): boolean {
  if (!process.stdin.isTTY) return false
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

// ─── Env hydration (migrated from wizard.ts) ─────────────────────────────────

/**
 * Hydrate process.env from stored auth.json credentials for optional tool keys.
 * Runs on every launch so extensions see Brave/Context7/Jina keys stored via the
 * wizard on prior launches.
 */
export function loadStoredEnvKeys(authStorage: AuthStorage): void {
  const providers: Array<[string, string]> = [
    ['brave',         'BRAVE_API_KEY'],
    ['brave_answers', 'BRAVE_ANSWERS_KEY'],
    ['context7',      'CONTEXT7_API_KEY'],
    ['jina',          'JINA_API_KEY'],
    ['slack_bot',     'SLACK_BOT_TOKEN'],
    ['discord_bot',   'DISCORD_BOT_TOKEN'],
  ]
  for (const [provider, envVar] of providers) {
    if (!process.env[envVar]) {
      const cred = authStorage.get(provider)
      if (cred?.type === 'api_key' && cred.key) {
        process.env[envVar] = cred.key
      }
    }
  }
}
