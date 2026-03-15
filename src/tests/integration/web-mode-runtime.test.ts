import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn, execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { chromium } from "playwright"

const projectRoot = process.cwd()
const resolveTsPath = join(projectRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
const loaderPath = join(projectRoot, "src", "loader.ts")
const builtAgentEntryPath = join(projectRoot, "packages", "pi-coding-agent", "dist", "index.js")
const packagedWebHostPath = join(projectRoot, "dist", "web", "standalone", "server.js")

const cliWeb = await import("../../cli-web-branch.ts")

let runtimeArtifactsReady = false

type LaunchResult = {
  exitCode: number | null
  stderr: string
  stdout: string
  url: string
  port: number
}

/**
 * Pre-populate a fake Anthropic API key in the temp home's auth.json so the
 * onboarding service sees a configured provider and unlocks without requiring
 * a real browser-based setup flow. The bridge agent ignores the key until an
 * actual LLM call is made, so get_state and boot readiness are unaffected.
 */
function writePreseededAuthFile(tempHome: string): void {
  const agentDir = join(tempHome, ".gsd", "agent")
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const authPath = join(agentDir, "auth.json")
  const fakeCredential = { type: "api_key", key: "sk-ant-test-fake-key-for-runtime-test" }
  writeFileSync(authPath, JSON.stringify({ anthropic: fakeCredential }, null, 2), { encoding: "utf-8", mode: 0o600 })
}

function createBrowserOpenStub(binDir: string, logPath: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open"
  const script = `#!/bin/sh\nprintf '%s\n' "$1" >> "${logPath}"\nexit 0\n`
  const scriptPath = join(binDir, command)
  writeFileSync(scriptPath, script, "utf-8")
  chmodSync(scriptPath, 0o755)
}

function runNpmScript(args: string[], label: string): void {
  try {
    execFileSync("npm", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string }
    throw new Error(`${label} failed: ${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim())
  }
}

function ensureRuntimeArtifacts(): void {
  if (runtimeArtifactsReady) return

  if (!existsSync(builtAgentEntryPath)) {
    runNpmScript(["run", "build:pi"], "npm run build:pi")
  }

  if (!existsSync(packagedWebHostPath)) {
    runNpmScript(["run", "build:web-host"], "npm run build:web-host")
  }

  runtimeArtifactsReady = true
}

function parseStartedUrl(stderr: string): string {
  const match = stderr.match(/\[gsd\] Web mode startup: status=started[^\n]*url=(http:\/\/[^\s]+)/)
  if (!match) {
    throw new Error(`Did not find successful web startup line in stderr:\n${stderr}`)
  }
  return match[1]
}

async function launchWebModeFromProject(tempHome: string, browserLogPath: string): Promise<LaunchResult> {
  ensureRuntimeArtifacts()

  const fakeBin = join(tempHome, "fake-bin")
  execFileSync("mkdir", ["-p", fakeBin])
  createBrowserOpenStub(fakeBin, browserLogPath)

  return await new Promise<LaunchResult>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = spawn(
      process.execPath,
      ["--import", resolveTsPath, "--experimental-strip-types", loaderPath, "--web"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          CI: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const finish = (result: LaunchResult | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (result instanceof Error) {
        reject(result)
        return
      }
      resolve(result)
    }

    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`Timed out waiting for gsd --web to exit. stderr so far:\n${stderr}`))
    }, 120_000)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      try {
        const url = parseStartedUrl(stderr)
        const parsed = new URL(url)
        finish({
          exitCode: code,
          stderr,
          stdout,
          url,
          port: Number(parsed.port),
        })
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}

async function waitForHttpOk(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) })
      if (response.ok) return
      lastError = new Error(`Unexpected ${response.status} for ${url}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function readFirstSseEvent(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  })

  assert.equal(response.ok, true, `expected SSE endpoint to respond successfully: ${response.status}`)
  assert.ok(response.body, "expected SSE response body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + 15_000

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const boundary = buffer.indexOf("\n\n")
      if (boundary === -1) continue

      const chunk = buffer.slice(0, boundary)
      const dataLine = chunk
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("data:"))

      if (!dataLine) continue

      controller.abort()
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
    }
  } finally {
    controller.abort()
    await reader.cancel().catch(() => undefined)
  }

  throw new Error("Timed out waiting for the first SSE event")
}

async function killProcessOnPort(port: number): Promise<void> {
  try {
    // Use -sTCP:LISTEN to match only the listening server process, not client
    // sockets from this test process or the Playwright browser. Killing client
    // PIDs would send SIGTERM to the test worker itself and abort the run.
    const output = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()

    for (const pid of output.split(/\s+/).filter(Boolean)) {
      // Guard: never kill ourselves.
      if (Number(pid) === process.pid) continue
      try {
        process.kill(Number(pid), "SIGTERM")
      } catch {
        // Best-effort cleanup only.
      }
    }
  } catch {
    // No listener found or lsof unavailable.
  }
}

test("gsd --web launches the live host and the shell attaches to boot plus SSE state", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs")
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-runtime-"))
  const tempHome = join(tempRoot, "home")
  const browserLogPath = join(tempRoot, "browser-open.log")
  let port: number | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  try {
    // Pre-seed auth so the onboarding service sees a configured provider and
    // unlocks without a browser-based setup flow. The bridge agent ignores the
    // fake key until an actual LLM call is made.
    writePreseededAuthFile(tempHome)

    const launch = await launchWebModeFromProject(tempHome, browserLogPath)
    port = launch.port

    assert.equal(launch.exitCode, 0, `expected the web launcher to exit cleanly:\n${launch.stderr}`)
    assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr")
    assert.ok(launch.stdout.trim().length === 0, `web launch should not emit interactive stdout: ${launch.stdout}`)

    await waitForHttpOk(`${launch.url}/api/boot`)

    const bootResponse = await fetch(`${launch.url}/api/boot`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(bootResponse.ok, true, `expected boot endpoint to respond successfully: ${bootResponse.status}`)

    const boot = await bootResponse.json()
    assert.equal(boot.project.cwd, projectRoot)
    assert.equal(boot.project.sessionsDir, cliWeb.getProjectSessionsDir(projectRoot, join(tempHome, ".gsd", "sessions")))
    assert.equal(boot.workspace.active.milestoneId, "M001")
    assert.match(boot.workspace.active.sliceId ?? "", /^S\d+$/)
    assert.equal(typeof boot.workspace.active.phase, "string")
    assert.ok(boot.workspace.active.phase.length > 0, "expected a non-empty active workspace phase")
    assert.equal(boot.bridge.phase, "ready")
    assert.equal(typeof boot.bridge.activeSessionId, "string")
    assert.ok(boot.bridge.activeSessionId.length > 0, "expected the bridge to attach a session during boot")

    const firstEvent = await readFirstSseEvent(`${launch.url}/api/session/events`)
    const bridgeEvent = firstEvent as {
      type: string
      bridge: { phase: string; activeSessionId: string; connectionCount: number }
    }
    assert.equal(bridgeEvent.type, "bridge_status")
    assert.equal(bridgeEvent.bridge.phase, "ready")
    assert.equal(typeof bridgeEvent.bridge.activeSessionId, "string")
    assert.ok(bridgeEvent.bridge.connectionCount >= 1, "expected an active SSE subscriber count")

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(launch.url, { waitUntil: "load" })

    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="workspace-connection-status"]')
        return Boolean(node?.textContent?.includes("Bridge connected"))
      },
      null,
      { timeout: 60_000 },
    )
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="sidebar-current-scope"]')
        return Boolean(node?.textContent?.match(/M001\/S\d+/))
      },
      null,
      { timeout: 60_000 },
    )
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="terminal-session-banner"]')
        return Boolean(node && !node.textContent?.includes("Waiting for live session"))
      },
      null,
      { timeout: 60_000 },
    )

    const connectionStatus = await page.locator('[data-testid="workspace-connection-status"]').textContent()
    const scopeLabel = await page.locator('[data-testid="sidebar-current-scope"]').textContent()
    const unitLabel = await page.locator('[data-testid="status-bar-unit"]').textContent()

    assert.match(connectionStatus ?? "", /Bridge connected/)
    assert.match(scopeLabel ?? "", /M001\/S\d+/)
    assert.match(unitLabel ?? "", /M001\/S\d+/)

    assert.ok(existsSync(browserLogPath), "expected the launcher to attempt opening the browser")
    const openedUrls = readFileSync(browserLogPath, "utf-8")
    assert.match(openedUrls, new RegExp(launch.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    await browser?.close().catch(() => undefined)
    if (port !== null) {
      await killProcessOnPort(port)
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
