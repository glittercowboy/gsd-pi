import type { AuthStorage } from '@gsd/pi-coding-agent'

// ─── Env hydration ────────────────────────────────────────────────────────────

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
    ['tavily',        'TAVILY_API_KEY'],
    ['slack_bot',     'SLACK_BOT_TOKEN'],
    ['discord_bot',   'DISCORD_BOT_TOKEN'],
    ['groq',          'GROQ_API_KEY'],
    ['ollama-cloud',  'OLLAMA_API_KEY'],
  ]
  for (const [provider, envVar] of providers) {
    if (!process.env[envVar]) {
      const cred = authStorage.get(provider)
      if (cred?.type === 'api_key' && cred.key) {
        process.env[envVar] = cred.key as string
      }
    }
  }
}
