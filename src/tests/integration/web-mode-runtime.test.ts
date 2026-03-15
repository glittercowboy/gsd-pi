import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn, execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { chromium, type Page } from "playwright"

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
    }, 180_000)

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

async function readFirstSseEventInPage(page: Page, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return await page.evaluate(
    async ({ timeoutMs }) => {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const source = new EventSource("/api/session/events")
        const timer = window.setTimeout(() => {
          source.close()
          reject(new Error("Timed out waiting for the first SSE event"))
        }, timeoutMs)

        source.onmessage = (event) => {
          window.clearTimeout(timer)
          source.close()
          try {
            resolve(JSON.parse(event.data) as Record<string, unknown>)
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }

        source.onerror = () => {
          window.clearTimeout(timer)
          source.close()
          reject(new Error("EventSource failed before the first SSE payload"))
        }
      })
    },
    { timeoutMs },
  )
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

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(launch.url, { waitUntil: "load" })

    const bootResult = await page.evaluate(async () => {
      const response = await fetch("/api/boot", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      return {
        ok: response.ok,
        status: response.status,
        boot: await response.json(),
      }
    })
    assert.equal(bootResult.ok, true, `expected boot endpoint to respond successfully: ${bootResult.status}`)

    const boot = bootResult.boot as {
      project: { cwd: string; sessionsDir: string }
      workspace: { active: { milestoneId?: string; sliceId?: string; phase?: string } }
      bridge: { phase: string; activeSessionId?: string }
    }
    assert.equal(boot.project.cwd, projectRoot)
    assert.equal(boot.project.sessionsDir, cliWeb.getProjectSessionsDir(projectRoot, join(tempHome, ".gsd", "sessions")))
    assert.match(boot.workspace.active.milestoneId ?? "", /^M\d+$/, "expected a live active milestone id")
    if ((boot.workspace.active.sliceId ?? "").length > 0) {
      assert.match(boot.workspace.active.sliceId ?? "", /^S\d+$/)
    }
    assert.equal(typeof boot.workspace.active.phase, "string")
    assert.ok((boot.workspace.active.phase ?? "").length > 0, "expected a non-empty active workspace phase")
    assert.equal(boot.bridge.phase, "ready")
    assert.equal(typeof boot.bridge.activeSessionId, "string")
    assert.ok((boot.bridge.activeSessionId ?? "").length > 0, "expected the bridge to attach a session during boot")

    const firstEvent = await readFirstSseEventInPage(page)
    const bridgeEvent = firstEvent as {
      type: string
      bridge: { phase: string; activeSessionId: string; connectionCount: number }
    }
    assert.equal(bridgeEvent.type, "bridge_status")
    assert.equal(bridgeEvent.bridge.phase, "ready")
    assert.equal(typeof bridgeEvent.bridge.activeSessionId, "string")
    assert.ok(bridgeEvent.bridge.connectionCount >= 1, "expected an active SSE subscriber count")

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
        return Boolean(node?.textContent?.match(/M\d+(?:\/S\d+(?:\/T\d+)?)?/))
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
    assert.match(scopeLabel ?? "", /M\d+(?:\/S\d+(?:\/T\d+)?)?/)
    assert.match(unitLabel ?? "", /M\d+(?:\/S\d+(?:\/T\d+)?)?|project\s+—/)

    await page.locator('[data-testid="dashboard-recovery-summary-entrypoint"]').click()
    await page.waitForSelector('[data-testid="command-surface-recovery"]', { timeout: 60_000 })
    const recoveryState = await page.locator('[data-testid="command-surface-recovery-state"]').textContent()
    assert.ok(recoveryState && recoveryState.length > 0, "expected the recovery diagnostics panel to expose a visible load state")

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
