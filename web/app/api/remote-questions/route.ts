import { homedir } from "node:os"
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs"
import { join, dirname } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ─── Constants (replicated from extensions — cannot import due to Turbopack constraint) ───

type RemoteChannel = "slack" | "discord" | "telegram"

const CHANNEL_ID_PATTERNS: Record<RemoteChannel, RegExp> = {
  slack: /^[A-Z0-9]{9,12}$/,
  discord: /^\d{17,20}$/,
  telegram: /^-?\d{5,20}$/,
}

const ENV_KEYS: Record<RemoteChannel, string> = {
  slack: "SLACK_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  telegram: "TELEGRAM_BOT_TOKEN",
}

const DEFAULT_TIMEOUT_MINUTES = 5
const DEFAULT_POLL_INTERVAL_SECONDS = 5
const MIN_TIMEOUT_MINUTES = 1
const MAX_TIMEOUT_MINUTES = 30
const MIN_POLL_INTERVAL_SECONDS = 2
const MAX_POLL_INTERVAL_SECONDS = 30

const VALID_CHANNELS: readonly RemoteChannel[] = ["slack", "discord", "telegram"] as const

// Map channel → auth.json provider ID (matches key-manager.ts PROVIDER_REGISTRY)
const AUTH_PROVIDER_IDS: Record<RemoteChannel, string> = {
  slack: "slack_bot",
  discord: "discord_bot",
  telegram: "telegram_bot",
}

// ─── Auth.json Helpers ────────────────────────────────────────────────────────

function getAuthPath(): string {
  return join(homedir(), ".gsd", "agent", "auth.json")
}

function readAuthData(): Record<string, unknown> {
  const authPath = getAuthPath()
  if (!existsSync(authPath)) return {}
  try {
    const content = readFileSync(authPath, "utf-8")
    const parsed = JSON.parse(content)
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function writeAuthData(data: Record<string, unknown>): void {
  const authPath = getAuthPath()
  const parentDir = dirname(authPath)
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true, mode: 0o700 })
  writeFileSync(authPath, JSON.stringify(data, null, 2), "utf-8")
  chmodSync(authPath, 0o600)
}

function hasStoredBotToken(channel: RemoteChannel): boolean {
  const data = readAuthData()
  const providerId = AUTH_PROVIDER_IDS[channel]
  const entry = data[providerId]
  if (!entry) return false
  // Could be a single credential or an array
  const creds = Array.isArray(entry) ? entry : [entry]
  return creds.some((c: unknown) => {
    if (typeof c !== "object" || c === null) return false
    const cred = c as Record<string, unknown>
    return cred.type === "api_key" && typeof cred.key === "string" && cred.key.length > 0
  })
}

function maskToken(token: string): string {
  if (token.length <= 8) return token.slice(0, 2) + "***" + token.slice(-2)
  return token.slice(0, 4) + "***" + token.slice(-4)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPreferencesPath(): string {
  return join(homedir(), ".gsd", "PREFERENCES.md")
}

function clamp(value: number | undefined, defaultVal: number, min: number, max: number): number {
  const v = typeof value === "number" && Number.isFinite(value) ? value : defaultVal
  return Math.max(min, Math.min(max, v))
}

function isValidChannel(ch: unknown): ch is RemoteChannel {
  return typeof ch === "string" && (VALID_CHANNELS as readonly string[]).includes(ch)
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Uses the same indexOf-based approach as parsePreferencesMarkdown() in preferences.ts.
 */
function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string; hasFrontmatter: boolean } {
  const startMarker = content.startsWith("---\r\n") ? "---\r\n" : "---\n"
  if (!content.startsWith(startMarker)) {
    return { data: {}, body: content, hasFrontmatter: false }
  }
  const searchStart = startMarker.length
  const endIdx = content.indexOf("\n---", searchStart)
  if (endIdx === -1) {
    return { data: {}, body: content, hasFrontmatter: false }
  }
  const block = content.slice(searchStart, endIdx)
  const afterFrontmatter = content.slice(endIdx + 4) // skip \n---

  try {
    const parsed = parseYaml(block.replace(/\r/g, ""))
    const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
    return { data, body: afterFrontmatter, hasFrontmatter: true }
  } catch {
    return { data: {}, body: content, hasFrontmatter: false }
  }
}

/**
 * Write frontmatter data back to a markdown file, preserving the body content.
 */
function writeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlStr = stringifyYaml(data, { lineWidth: 0 }).trimEnd()
  return `---\n${yamlStr}\n---${body}`
}

interface RemoteQuestionsResponse {
  config: {
    channel: RemoteChannel
    channelId: string
    timeoutMinutes: number
    pollIntervalSeconds: number
  } | null
  envVarSet: boolean
  tokenSet: boolean
  envVarName: string | null
  status: string
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    const prefsPath = getPreferencesPath()

    if (!existsSync(prefsPath)) {
      const response: RemoteQuestionsResponse = {
        config: null,
        envVarSet: false,
        tokenSet: false,
        envVarName: null,
        status: "not_configured",
      }
      return Response.json(response, {
        headers: { "Cache-Control": "no-store" },
      })
    }

    const content = readFileSync(prefsPath, "utf-8")
    const { data } = parseFrontmatter(content)
    const rq = data.remote_questions as Record<string, unknown> | undefined

    if (!rq || typeof rq !== "object" || !rq.channel) {
      const response: RemoteQuestionsResponse = {
        config: null,
        envVarSet: false,
        tokenSet: false,
        envVarName: null,
        status: "not_configured",
      }
      return Response.json(response, {
        headers: { "Cache-Control": "no-store" },
      })
    }

    const channel = rq.channel as string
    if (!isValidChannel(channel)) {
      const response: RemoteQuestionsResponse = {
        config: null,
        envVarSet: false,
        tokenSet: false,
        envVarName: null,
        status: "invalid_channel",
      }
      return Response.json(response, {
        headers: { "Cache-Control": "no-store" },
      })
    }

    const channelId = rq.channel_id != null ? String(rq.channel_id) : ""
    const timeoutMinutes = clamp(rq.timeout_minutes as number | undefined, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES)
    const pollIntervalSeconds = clamp(rq.poll_interval_seconds as number | undefined, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS)
    const envVarName = ENV_KEYS[channel]
    const envVarSet = !!process.env[envVarName]
    const tokenSet = hasStoredBotToken(channel) || envVarSet

    const response: RemoteQuestionsResponse = {
      config: {
        channel,
        channelId,
        timeoutMinutes,
        pollIntervalSeconds,
      },
      envVarSet,
      tokenSet,
      envVarName,
      status: "configured",
    }
    return Response.json(response, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: `Failed to read remote questions config: ${message}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>
    const { channel, channelId, timeoutMinutes: rawTimeout, pollIntervalSeconds: rawPoll } = body as {
      channel: unknown
      channelId: unknown
      timeoutMinutes: unknown
      pollIntervalSeconds: unknown
    }

    // Validate channel
    if (!isValidChannel(channel)) {
      return Response.json(
        { error: `Invalid channel type: must be one of ${VALID_CHANNELS.join(", ")}` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }

    // Validate channelId
    if (typeof channelId !== "string" || !channelId) {
      return Response.json(
        { error: "channelId is required and must be a non-empty string" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }

    if (!CHANNEL_ID_PATTERNS[channel].test(channelId)) {
      return Response.json(
        { error: `Invalid channel ID format for ${channel}. Expected pattern: ${CHANNEL_ID_PATTERNS[channel].source}` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }

    // Clamp timeout and poll interval
    const timeoutMinutes = clamp(rawTimeout as number | undefined, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES)
    const pollIntervalSeconds = clamp(rawPoll as number | undefined, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS)

    // Read current preferences
    const prefsPath = getPreferencesPath()
    let data: Record<string, unknown> = {}
    let body2 = ""

    if (existsSync(prefsPath)) {
      const content = readFileSync(prefsPath, "utf-8")
      const parsed = parseFrontmatter(content)
      data = parsed.data
      body2 = parsed.body
    }

    // Update remote_questions block
    data.remote_questions = {
      channel,
      channel_id: channelId,
      timeout_minutes: timeoutMinutes,
      poll_interval_seconds: pollIntervalSeconds,
    }

    // Write back
    const dir = dirname(prefsPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(prefsPath, writeFrontmatter(data, body2), "utf-8")

    return Response.json(
      {
        success: true,
        config: { channel, channelId, timeoutMinutes, pollIntervalSeconds },
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: `Failed to save remote questions config: ${message}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(): Promise<Response> {
  try {
    const prefsPath = getPreferencesPath()

    if (!existsSync(prefsPath)) {
      return Response.json(
        { success: true },
        { headers: { "Cache-Control": "no-store" } },
      )
    }

    const content = readFileSync(prefsPath, "utf-8")
    const { data, body, hasFrontmatter } = parseFrontmatter(content)

    if (!hasFrontmatter || !data.remote_questions) {
      return Response.json(
        { success: true },
        { headers: { "Cache-Control": "no-store" } },
      )
    }

    delete data.remote_questions
    writeFileSync(prefsPath, writeFrontmatter(data, body), "utf-8")

    return Response.json(
      { success: true },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: `Failed to remove remote questions config: ${message}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}

// ─── PATCH (save bot token) ───────────────────────────────────────────────────

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>
    const { channel, token } = body as { channel: unknown; token: unknown }

    if (!isValidChannel(channel)) {
      return Response.json(
        { error: `Invalid channel type: must be one of ${VALID_CHANNELS.join(", ")}` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }

    if (typeof token !== "string" || !token.trim()) {
      return Response.json(
        { error: "token is required and must be a non-empty string" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }

    const trimmedToken = token.trim()
    const providerId = AUTH_PROVIDER_IDS[channel]

    // Read existing auth data, merge the new credential
    const authData = readAuthData()
    const existingEntry = authData[providerId]
    const existingCreds: unknown[] = existingEntry
      ? (Array.isArray(existingEntry) ? existingEntry : [existingEntry])
      : []

    // Replace any existing api_key credential, keep OAuth
    const oauthCreds = existingCreds.filter((c: unknown) => {
      if (typeof c !== "object" || c === null) return false
      return (c as Record<string, unknown>).type === "oauth"
    })
    const newCred = { type: "api_key", key: trimmedToken }
    const merged = [...oauthCreds, newCred]
    authData[providerId] = merged.length === 1 ? merged[0] : merged
    writeAuthData(authData)

    // Also set in process.env so it's available immediately
    const envVar = ENV_KEYS[channel]
    process.env[envVar] = trimmedToken

    return Response.json(
      { success: true, masked: maskToken(trimmedToken) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: `Failed to save bot token: ${message}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
