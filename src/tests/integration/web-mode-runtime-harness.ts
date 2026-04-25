import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Page, Request, Response } from "playwright"

const projectRoot = process.cwd()
const resolveTsPath = join(projectRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
const loaderPath = join(projectRoot, "src", "loader.ts")
const builtAgentEntryPath = join(projectRoot, "packages", "pi-coding-agent", "dist", "index.js")
const packagedWebHostPath = join(projectRoot, "dist", "web", "standalone", "server.js")

let runtimeArtifactsReady = false

const SANITIZED_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "HF_TOKEN",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "ALIBABA_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const

function buildSanitizedRuntimeEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of SANITIZED_PROVIDER_ENV_KEYS) {
    env[key] = ""
  }
  return {
    ...env,
    ...overrides,
  }
}

type RuntimeEndpoint = "boot" | "events"

type RuntimeRequestDiagnostic = {
  url: string
  method: string
  status: number | null
  failure: string | null
}

export type RuntimeLaunchResult = {
  exitCode: number | null
  stderr: string
  stdout: string
  url: string
  port: number
  /** Auth token extracted from the browser URL fragment, if present. */
  authToken: string | null
  launchCwd: string
  tempHome: string
  browserLogPath: string
}

export type BrowserBootResult<TBoot = unknown> = {
  ok: boolean
  status: number
  boot: TBoot
}

export type RuntimeNetworkDiagnostics = {
  bootRequests: RuntimeRequestDiagnostic[]
  sseRequests: RuntimeRequestDiagnostic[]
}

export type RuntimeReadyProof<TBoot = unknown> = {
  bootResult: BrowserBootResult<TBoot>
  firstEvent: Record<string, unknown>
  diagnostics: RuntimeNetworkDiagnostics
  visible: {
    connectionStatus: string | null
    scopeLabel: string | null
    unitLabel: string | null
    sessionBanner: string | null
    projectPathTitle: string | null
    sidebarRecoveryEntrypoint: string | null
    recoveryPanelState: string | null
  }
}

export function writePreseededAuthFile(tempHome: string): void {
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

export function ensureRuntimeArtifacts(): void {
  if (runtimeArtifactsReady) return

  if (!existsSync(builtAgentEntryPath)) {
    runNpmScript(["run", "build:pi"], "npm run build:pi")
  }

  if (!existsSync(packagedWebHostPath)) {
    runNpmScript(["run", "build:web-host"], "npm run build:web-host")
  }

  runtimeArtifactsReady = true
}

export function parseStartedUrl(stderr: string): string {
  const match = stderr.match(/\[gsd\] Web mode startup: status=started[^\n]*url=(http:\/\/[^\s]+)/)
  if (!match) {
    throw new Error(`Did not find successful web startup line in stderr:\n${stderr}`)
  }
  return match[1]
}

function parseReadyAuthToken(stderr: string): string | null {
  const match = stderr.match(/\[gsd\] Ready → http:\/\/[^\s]+\/#token=([a-f0-9]{64})/)
  return match?.[1] ?? null
}

export async function launchPackagedWebHost(options: {
  launchCwd: string
  tempHome: string
  browserLogPath?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<RuntimeLaunchResult> {
  ensureRuntimeArtifacts()

  mkdirSync(join(options.tempHome, ".gsd"), { recursive: true })
  const browserLogPath = options.browserLogPath ?? join(options.tempHome, "browser-open.log")
  const fakeBin = join(options.tempHome, "fake-bin")
  mkdirSync(fakeBin, { recursive: true })
  createBrowserOpenStub(fakeBin, browserLogPath)

  return await new Promise<RuntimeLaunchResult>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = spawn(
      process.execPath,
      ["--import", resolveTsPath, "--experimental-strip-types", loaderPath, "--web"],
      {
        cwd: options.launchCwd,
        env: {
          ...buildSanitizedRuntimeEnv(options.env),
          HOME: options.tempHome,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          CI: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const finish = (result: RuntimeLaunchResult | Error) => {
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
    }, options.timeoutMs ?? 180_000)

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
        // Extract the auth token from the browser-open stub log.
        // The launcher passes `http://host:port/#token=<hex>` to `open`.
        let authToken: string | null = null
        try {
          if (existsSync(browserLogPath)) {
            const openedUrl = readFileSync(browserLogPath, "utf-8").trim()
            const tokenMatch = openedUrl.match(/#token=([a-fA-F0-9]+)/)
            if (tokenMatch) authToken = tokenMatch[1]
          }
        } catch {
          // Non-fatal — tests that don't need the token can proceed without it
        }
        if (!authToken) {
          authToken = parseReadyAuthToken(stderr)
        }
        finish({
          exitCode: code,
          stderr,
          stdout,
          url,
          port: Number(parsed.port),
          authToken,
          launchCwd: options.launchCwd,
          tempHome: options.tempHome,
          browserLogPath,
        })
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}

export async function waitForHttpOk(url: string, timeoutMs = 60_000, headers?: Record<string, string>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(5_000, deadline - Date.now())
      const requestTimeoutMs = Math.min(15_000, remainingMs)
      const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(requestTimeoutMs) })
      if (response.ok) return
      lastError = new Error(`Unexpected ${response.status} for ${url}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Build an Authorization header object from a launch result's auth token.
 * Returns an empty object if no token is present (server launched without auth).
 */
export function runtimeAuthHeaders(launch: RuntimeLaunchResult): Record<string, string> {
  if (!launch.authToken) return {}
  return { Authorization: `Bearer ${launch.authToken}` }
}

export async function killProcessOnPort(port: number): Promise<void> {
  const readListenerPids = (): number[] => {
    try {
      const output = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      return output
        .split(/\s+/)
        .filter(Boolean)
        .map((pid) => Number(pid))
        .filter((pid) => Number.isFinite(pid) && pid !== process.pid)
    } catch {
      return []
    }
  }

  const initialPids = readListenerPids()
  for (const pid of initialPids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Best-effort cleanup only.
    }
  }

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (readListenerPids().length === 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function assertBrowserOpenAttempt(browserLogPath: string, expectedUrl: string, timeoutMs = 5_000): Promise<void> {
  const expectedUrlPattern = new RegExp(escapeRegExp(expectedUrl))
  const deadline = Date.now() + timeoutMs
  let openedUrls = ""

  while (Date.now() < deadline) {
    if (existsSync(browserLogPath)) {
      openedUrls = readFileSync(browserLogPath, "utf-8")
      if (expectedUrlPattern.test(openedUrls)) {
        return
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  assert.ok(existsSync(browserLogPath), `expected the launcher to attempt opening the browser within ${timeoutMs}ms`)
  openedUrls = readFileSync(browserLogPath, "utf-8")
  assert.match(openedUrls, expectedUrlPattern)
}

export async function fetchBootInPage<TBoot = unknown>(page: Page): Promise<BrowserBootResult<TBoot>> {
  return await page.evaluate(async () => {
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
}

export async function readFirstSseEventInPage(page: Page, timeoutMs = 15_000): Promise<Record<string, unknown>> {
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

function createRuntimeNetworkDiagnostics(page: Page): {
  snapshot: () => RuntimeNetworkDiagnostics
  dispose: () => void
} {
  const bootRequests: RuntimeRequestDiagnostic[] = []
  const sseRequests: RuntimeRequestDiagnostic[] = []
  const trackedRequests = new Map<Request, RuntimeRequestDiagnostic>()

  const classifyEndpoint = (url: string): RuntimeEndpoint | null => {
    const pathname = new URL(url).pathname
    if (pathname === "/api/boot") return "boot"
    if (pathname === "/api/session/events") return "events"
    return null
  }

  const onRequest = (request: Request) => {
    const endpoint = classifyEndpoint(request.url())
    if (!endpoint) return

    const entry: RuntimeRequestDiagnostic = {
      url: request.url(),
      method: request.method(),
      status: null,
      failure: null,
    }

    trackedRequests.set(request, entry)
    if (endpoint === "boot") {
      bootRequests.push(entry)
      return
    }
    sseRequests.push(entry)
  }

  const onResponse = (response: Response) => {
    const entry = trackedRequests.get(response.request())
    if (!entry) return
    entry.status = response.status()
  }

  const onRequestFailed = (request: Request) => {
    const entry = trackedRequests.get(request)
    if (!entry) return
    entry.failure = request.failure()?.errorText ?? "request failed"
  }

  page.on("request", onRequest)
  page.on("response", onResponse)
  page.on("requestfailed", onRequestFailed)

  return {
    snapshot: () => ({
      bootRequests: bootRequests.map((entry) => ({ ...entry })),
      sseRequests: sseRequests.map((entry) => ({ ...entry })),
    }),
    dispose: () => {
      page.off("request", onRequest)
      page.off("response", onResponse)
      page.off("requestfailed", onRequestFailed)
    },
  }
}

function formatRequestDiagnostics(diagnostics: RuntimeNetworkDiagnostics): string {
  const formatEntries = (entries: RuntimeRequestDiagnostic[]) => {
    if (entries.length === 0) return "none"
    return entries
      .map((entry) => {
        const status = entry.status === null ? "pending" : String(entry.status)
        return `${entry.method} ${entry.url} status=${status}${entry.failure ? ` failure=${entry.failure}` : ""}`
      })
      .join(" | ")
  }

  return `browser /api/boot: ${formatEntries(diagnostics.bootRequests)}\nbrowser /api/session/events: ${formatEntries(diagnostics.sseRequests)}`
}

function buildFailureContext(label: string, diagnostics: RuntimeNetworkDiagnostics, launchStderr?: string): string {
  return [
    `${label} diagnostics:`,
    formatRequestDiagnostics(diagnostics),
    launchStderr ? `launcher stderr:\n${launchStderr}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function normalizeComparablePath(path: string | null | undefined): string | null {
  if (!path) return path ?? null
  try {
    return realpathSync.native?.(path) ?? realpathSync(path)
  } catch {
    return path
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export async function waitForLaunchedHostReady<TBoot extends { project: { cwd: string; sessionsDir?: string }; bridge: { phase?: string; activeSessionId?: string } }>(
  page: Page,
  options: {
    label: string
    expectedProjectCwd: string
    expectedSessionsDir?: string | string[]
    launchStderr?: string
    navigation?: () => Promise<unknown>
    timeoutMs?: number
  },
): Promise<RuntimeReadyProof<TBoot>> {
  const markerTimeout = options.timeoutMs ?? 60_000
  const requestProbe = createRuntimeNetworkDiagnostics(page)

  try {
    await options.navigation?.()

    const bootResult = await fetchBootInPage<TBoot>(page)
    const firstEvent = await readFirstSseEventInPage(page)

    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="sidebar-current-scope"]')
        return Boolean(node?.textContent?.match(/M\d+(?:\/S\d+(?:\/T\d+)?)?/))
      },
      null,
      { timeout: markerTimeout },
    )
    await page.waitForSelector('[data-testid="sidebar-recovery-summary-entrypoint"]', {
      state: "visible",
      timeout: markerTimeout,
    })

    const diagnostics = requestProbe.snapshot()
    const failureContext = buildFailureContext(options.label, diagnostics, options.launchStderr)

    assert.equal(bootResult.ok, true, `${options.label}: expected /api/boot to respond successfully, got ${bootResult.status}\n${failureContext}`)
    assert.ok(diagnostics.bootRequests.length > 0, `${options.label}: expected browser-visible /api/boot traffic\n${failureContext}`)
    assert.ok(diagnostics.bootRequests.some((entry) => entry.status === 200), `${options.label}: browser never saw a 200 /api/boot response\n${failureContext}`)
    assert.ok(diagnostics.bootRequests.every((entry) => entry.failure === null), `${options.label}: browser /api/boot request failed\n${failureContext}`)
    assert.ok(diagnostics.sseRequests.length > 0, `${options.label}: expected browser-visible /api/session/events traffic\n${failureContext}`)
    assert.ok(diagnostics.sseRequests.some((entry) => entry.status === 200), `${options.label}: browser never saw a 200 /api/session/events response\n${failureContext}`)
    assert.ok(
      diagnostics.sseRequests.every((entry) => entry.failure === null || /ERR_ABORTED/i.test(entry.failure)),
      `${options.label}: browser /api/session/events hit an unexpected network failure\n${failureContext}`,
    )

    const boot = bootResult.boot
    const normalizedExpectedProjectCwd = normalizeComparablePath(options.expectedProjectCwd)
    const normalizedBootProjectCwd = normalizeComparablePath(boot.project.cwd)
    assert.equal(normalizedBootProjectCwd, normalizedExpectedProjectCwd, `${options.label}: boot project cwd drifted\n${failureContext}`)
    if (options.expectedSessionsDir) {
      const expectedSessionsDirs = (Array.isArray(options.expectedSessionsDir) ? options.expectedSessionsDir : [options.expectedSessionsDir])
        .map((entry) => normalizeComparablePath(entry))
      const normalizedBootSessionsDir = normalizeComparablePath(boot.project.sessionsDir)
      assert.ok(
        expectedSessionsDirs.includes(normalizedBootSessionsDir),
        `${options.label}: boot sessions dir drifted\nexpected one of ${JSON.stringify(expectedSessionsDirs)}\nreceived ${JSON.stringify(normalizedBootSessionsDir)}\n${failureContext}`,
      )
    }
    assert.equal(boot.bridge.phase, "ready", `${options.label}: boot bridge phase was not ready\n${failureContext}`)
    assert.equal(typeof boot.bridge.activeSessionId, "string", `${options.label}: boot missed activeSessionId\n${failureContext}`)
    assert.ok((boot.bridge.activeSessionId ?? "").length > 0, `${options.label}: boot activeSessionId was empty\n${failureContext}`)

    const bridgeEvent = firstEvent as {
      type?: string
      bridge?: { phase?: string; activeSessionId?: string; connectionCount?: number }
    }
    assert.equal(bridgeEvent.type, "bridge_status", `${options.label}: first SSE payload drifted away from bridge_status\n${failureContext}`)
    assert.equal(bridgeEvent.bridge?.phase, "ready", `${options.label}: first SSE bridge phase was not ready\n${failureContext}`)
    assert.equal(typeof bridgeEvent.bridge?.activeSessionId, "string", `${options.label}: first SSE payload missed activeSessionId\n${failureContext}`)
    assert.ok((bridgeEvent.bridge?.activeSessionId ?? "").length > 0, `${options.label}: first SSE activeSessionId was empty\n${failureContext}`)
    assert.ok((bridgeEvent.bridge?.connectionCount ?? 0) >= 1, `${options.label}: first SSE connection count never became active\n${failureContext}`)

    const visible = {
      scopeLabel: await page.locator('[data-testid="sidebar-current-scope"]').textContent(),
      unitLabel: await page.locator('[data-testid="status-bar-unit"]').textContent(),
      sessionBanner: await page.locator('[data-testid="terminal-session-banner"]').textContent().catch(() => null),
      projectPathTitle: await page.locator('[data-testid="workspace-project-cwd"]').getAttribute("title"),
      sidebarRecoveryEntrypoint: await page.locator('[data-testid="sidebar-recovery-summary-entrypoint"]').textContent(),
      recoveryPanelState: null as string | null,
    }

    assert.match(visible.scopeLabel ?? "", /M\d+(?:\/S\d+(?:\/T\d+)?)?/, `${options.label}: current scope marker never became visible\n${failureContext}`)
    assert.match(visible.unitLabel ?? "", /M\d+(?:\/S\d+(?:\/T\d+)?)?|project\s+—/, `${options.label}: status-bar unit marker drifted\n${failureContext}`)
    assert.equal(
      normalizeComparablePath(visible.projectPathTitle),
      normalizedExpectedProjectCwd,
      `${options.label}: browser shell showed the wrong current project path\n${failureContext}`,
    )
    assert.ok((visible.sidebarRecoveryEntrypoint ?? "").trim().length > 0, `${options.label}: sidebar recovery entrypoint was empty\n${failureContext}`)

    return {
      bootResult,
      firstEvent,
      diagnostics,
      visible,
    }
  } finally {
    requestProbe.dispose()
  }
}
