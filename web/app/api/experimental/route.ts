import { homedir } from "node:os"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" } as const

// ─── Helpers (same pattern as remote-questions/route.ts) ─────────────────────

function getPreferencesPath(): string {
  return join(homedir(), ".gsd", "PREFERENCES.md")
}

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const startMarker = content.startsWith("---\r\n") ? "---\r\n" : "---\n"
  if (!content.startsWith(startMarker)) return { data: {}, body: content }
  const searchStart = startMarker.length
  const endIdx = content.indexOf("\n---", searchStart)
  if (endIdx === -1) return { data: {}, body: content }
  const block = content.slice(searchStart, endIdx)
  const afterFrontmatter = content.slice(endIdx + 4)
  try {
    const parsed = parseYaml(block.replace(/\r/g, ""))
    const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
    return { data, body: afterFrontmatter }
  } catch {
    return { data: {}, body: content }
  }
}

function writeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlStr = stringifyYaml(data, { lineWidth: 0 }).trimEnd()
  return `---\n${yamlStr}\n---${body}`
}

function readPrefs(): { data: Record<string, unknown>; body: string } {
  const path = getPreferencesPath()
  if (!existsSync(path)) return { data: {}, body: "\n" }
  const content = readFileSync(path, "utf-8")
  return parseFrontmatter(content)
}

function writePrefs(data: Record<string, unknown>, body: string): void {
  const path = getPreferencesPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, writeFrontmatter(data, body), "utf-8")
}

// ─── GET — read current experimental flags ───────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    const { data } = readPrefs()
    const exp = typeof data.experimental === "object" && data.experimental !== null
      ? (data.experimental as Record<string, unknown>)
      : {}
    return Response.json({ rtk: exp.rtk === true }, { headers: NO_STORE })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500, headers: NO_STORE })
  }
}

// ─── PATCH — toggle an experimental flag ────────────────────────────────────
//
// Body: { flag: "rtk", enabled: boolean }

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>
    const { flag, enabled } = body

    const KNOWN_FLAGS = new Set(["rtk"])
    if (typeof flag !== "string" || !KNOWN_FLAGS.has(flag)) {
      return Response.json(
        { error: `Unknown experimental flag "${flag}". Known flags: ${[...KNOWN_FLAGS].join(", ")}` },
        { status: 400, headers: NO_STORE },
      )
    }
    if (typeof enabled !== "boolean") {
      return Response.json(
        { error: "enabled must be a boolean" },
        { status: 400, headers: NO_STORE },
      )
    }

    const { data, body: mdBody } = readPrefs()

    // Merge into experimental block
    const existing = typeof data.experimental === "object" && data.experimental !== null
      ? { ...(data.experimental as Record<string, unknown>) }
      : {}
    existing[flag] = enabled
    data.experimental = existing

    writePrefs(data, mdBody)

    return Response.json({ [flag]: enabled }, { headers: NO_STORE })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json(
      { error: `Failed to update experimental flag: ${message}` },
      { status: 500, headers: NO_STORE },
    )
  }
}
