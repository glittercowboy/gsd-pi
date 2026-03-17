import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { chromium, type Page, type Request as PlaywrightRequest, type Response as PlaywrightResponse } from "playwright"

import { getProjectSessionsDir } from "../../cli-web-branch.ts"
import {
  makeInterruptedRunRuntimeFixture,
  makeRuntimeWorkspaceFixture,
  seedCurrentProjectSession,
  seedInterruptedRunRecoverySessions,
} from "./web-mode-runtime-fixtures.ts"
import {
  assertBrowserOpenAttempt,
  killProcessOnPort,
  launchPackagedWebHost,
  waitForHttpOk,
  waitForLaunchedHostReady,
  writePreseededAuthFile,
} from "./web-mode-runtime-harness.ts"

type RuntimeBootPayload = {
  project: { cwd: string; sessionsDir: string }
  workspace: { active: { milestoneId?: string; sliceId?: string; phase?: string } }
  bridge: { phase: string; activeSessionId?: string }
}

type BridgeStatusEvent = {
  type: string
  bridge: { phase: string; activeSessionId: string; connectionCount: number }
}

function canonicalizePath(path: string): string {
  return realpathSync.native?.(path) ?? realpathSync(path)
}

function expectedRuntimeSessionsDirs(projectCwd: string, tempHome: string): string[] {
  const cwdVariants = [projectCwd, canonicalizePath(projectCwd)]
  const baseDirs = [join(tempHome, ".gsd", "sessions"), join(tempHome, ".gsd", "agent", "sessions")]
  return [...new Set(cwdVariants.flatMap((cwd) => baseDirs.map((baseDir) => getProjectSessionsDir(cwd, baseDir))))]
}

function parseCommandRequest(request: PlaywrightRequest): Record<string, unknown> | null {
  const body = request.postData()
  if (!body) return null

  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

async function submitTerminalInput(page: Page, input: string): Promise<void> {
  const field = page.locator('[data-testid="terminal-command-input"]')
  await field.fill(input)
  await field.press("Enter")
}

async function closeCommandSurfaceIfOpen(page: Page, label = "command surface"): Promise<void> {
  const surface = page.locator('[data-testid="command-surface"]')
  const isVisible = await surface.isVisible().catch(() => false)
  if (!isVisible) return

  await surface.getByRole("button", { name: "Close" }).first().click()
  await page.waitForSelector('[data-testid="command-surface"]', { state: "hidden", timeout: 15_000 }).catch(async () => {
    const title = await page.locator('[data-testid="command-surface-title"]').textContent().catch(() => null)
    assert.fail(`${label}: expected the command surface to close, but it stayed visible with title ${title ?? "unknown"}`)
  })
}

async function waitForTerminalLine(page: Page, needle: string, label: string, timeoutMs = 20_000): Promise<void> {
  try {
    await page.waitForFunction(
      ({ needle }) =>
        Array.from(document.querySelectorAll('[data-testid="terminal-line"]')).some((node) =>
          node.textContent?.includes(needle),
        ),
      { needle },
      { timeout: timeoutMs },
    )
  } catch {
    const lines = await page.locator('[data-testid="terminal-line"]').allTextContents().catch(() => [])
    assert.fail(`${label}: expected a terminal line containing ${JSON.stringify(needle)}, got ${JSON.stringify(lines.slice(-12))}`)
  }
}

async function waitForCommandResponse(
  page: Page,
  options: {
    label: string
    type: string
    message?: string
    status?: number
    action: () => Promise<void>
  },
): Promise<PlaywrightResponse> {
  const expectedStatus = options.status ?? 200
  const responsePromise = page.waitForResponse(
    (response) => {
      if (new URL(response.url()).pathname !== "/api/session/command") return false
      if (response.request().method() !== "POST") return false
      if (response.status() !== expectedStatus) return false

      const body = parseCommandRequest(response.request())
      if (!body || body.type !== options.type) return false
      if (options.message !== undefined) {
        return body.message === options.message
      }
      return true
    },
    { timeout: 20_000 },
  )

  await options.action()

  try {
    return await responsePromise
  } catch {
    assert.fail(`${options.label}: never observed /api/session/command type=${options.type} status=${expectedStatus}`)
  }
}

async function waitForGetResponse(
  page: Page,
  options: {
    label: string
    pathname: string
    status?: number
    action: () => Promise<void>
  },
): Promise<PlaywrightResponse> {
  const expectedStatus = options.status ?? 200
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === options.pathname && response.request().method() === "GET" && response.status() === expectedStatus,
    { timeout: 20_000 },
  )

  await options.action()

  try {
    return await responsePromise
  } catch {
    assert.fail(`${options.label}: never observed GET ${options.pathname} status=${expectedStatus}`)
  }
}

type RuntimeRecoveryPayload = {
  status: "ready" | "unavailable"
  project: {
    cwd: string
    activeScope: string | null
    activeSessionPath: string | null
    activeSessionId: string | null
  }
  summary: {
    label: string
    detail: string
    currentUnitId: string | null
  }
  doctor: {
    total: number
  }
  interruptedRun: {
    available: boolean
    detected: boolean
    counts: {
      toolCalls: number
      filesWritten: number
      commandsRun: number
      errors: number
    }
    unit: {
      type: string
      id: string
    } | null
    lastError: string | null
  }
  actions: {
    browser: Array<{ id: string; label: string }>
    commands: Array<{ command: string; label: string }>
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function waitForJsonGetResponse<T>(
  page: Page,
  options: {
    label: string
    pathname: string
    status?: number
    action: () => Promise<void>
  },
): Promise<T> {
  const response = await waitForGetResponse(page, options)

  try {
    return await response.json() as T
  } catch {
    assert.fail(`${options.label}: GET ${options.pathname} did not return JSON`)
  }
}

function assertRecoveryPayload(
  payload: RuntimeRecoveryPayload,
  options: {
    label: string
    expectedScope: string
    expectedSessionId: string
    leakedSecret: string
  },
): void {
  assert.equal(payload.status, "ready", `${options.label}: expected recovery payload status=ready`)
  assert.equal(payload.project.activeScope, options.expectedScope, `${options.label}: recovery active scope drifted`)
  assert.equal(payload.project.activeSessionId, options.expectedSessionId, `${options.label}: recovery active session drifted`)
  assert.equal(payload.interruptedRun.available, true, `${options.label}: interrupted-run evidence should be available`)
  assert.equal(payload.interruptedRun.detected, true, `${options.label}: interrupted-run evidence should be detected`)
  assert.ok(payload.interruptedRun.counts.toolCalls >= 3, `${options.label}: expected tool-call evidence in interrupted-run counts`)
  assert.ok(payload.interruptedRun.counts.filesWritten >= 1, `${options.label}: expected file-write evidence in interrupted-run counts`)
  assert.ok(payload.interruptedRun.counts.commandsRun >= 1, `${options.label}: expected command evidence in interrupted-run counts`)
  assert.ok(payload.interruptedRun.counts.errors >= 1, `${options.label}: expected error evidence in interrupted-run counts`)
  assert.match(payload.interruptedRun.lastError ?? "", /\[redacted\]/, `${options.label}: last interrupted-run error should stay redacted`)
  assert.doesNotMatch(payload.interruptedRun.lastError ?? "", new RegExp(escapeRegExp(options.leakedSecret)))

  const browserActionIds = payload.actions.browser.map((action) => action.id)
  assert.ok(browserActionIds.includes("refresh_diagnostics"), `${options.label}: missing refresh_diagnostics action`)
  assert.ok(browserActionIds.includes("refresh_workspace"), `${options.label}: missing refresh_workspace action`)
  assert.ok(browserActionIds.includes("open_resume_controls"), `${options.label}: missing open_resume_controls action`)
  assert.ok(
    payload.actions.commands.some((command) => command.command.includes("/gsd doctor")),
    `${options.label}: expected a scoped /gsd doctor command suggestion`,
  )
}

async function openRecoveryPanel(page: Page): Promise<void> {
  // Open settings surface if not already open
  const surfaceVisible = await page.locator('[data-testid="command-surface"]').isVisible().catch(() => false)
  if (!surfaceVisible) {
    await submitTerminalInput(page, "/settings")
    await page.waitForSelector('[data-testid="command-surface"]', { state: "visible", timeout: 20_000 })
  }
  // Click recovery section tab
  const recoveryTab = page.locator('[data-testid="command-surface-section-recovery"]')
  if (await recoveryTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await recoveryTab.click()
  }
}

async function assertRecoveryPanel(
  page: Page,
  options: {
    label: string
    expectedScope: string
    leakedSecret: string
  },
): Promise<void> {
  await page.waitForSelector('[data-testid="command-surface-recovery-actions"]', { state: "visible", timeout: 20_000 })

  const stateText = (await page.locator('[data-testid="command-surface-recovery-state"]').textContent()) ?? ""
  const summaryText = (await page.locator('[data-testid="command-surface-recovery-summary"]').textContent()) ?? ""
  const interruptedRunText = (await page.locator('[data-testid="command-surface-recovery-interrupted-run"]').textContent()) ?? ""
  const actionsText = (await page.locator('[data-testid="command-surface-recovery-actions"]').textContent()) ?? ""
  const commandsText = (await page.locator('[data-testid="command-surface-recovery-commands"]').textContent()) ?? ""
  const panelText = (await page.locator('[data-testid="command-surface-recovery"]').textContent()) ?? ""
  const actionIds = await page.locator('[data-testid^="command-surface-recovery-action-"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid") ?? ""),
  )

  assert.ok(stateText.trim().length > 0, `${options.label}: recovery state marker was empty`)
  assert.match(summaryText, new RegExp(escapeRegExp(options.expectedScope)), `${options.label}: recovery summary lost the seeded scope`)
  assert.match(interruptedRunText, /Available:\s*yes/, `${options.label}: interrupted-run availability marker drifted`)
  assert.match(interruptedRunText, /Detected:\s*yes/, `${options.label}: interrupted-run detection marker drifted`)
  assert.match(interruptedRunText, /Tool calls:\s*[1-9]/, `${options.label}: interrupted-run tool-call count was not visible`)
  assert.match(interruptedRunText, /Files written:\s*[1-9]/, `${options.label}: interrupted-run file-write count was not visible`)
  assert.match(interruptedRunText, /Commands:\s*[1-9]/, `${options.label}: interrupted-run command count was not visible`)
  assert.match(interruptedRunText, /Errors:\s*[1-9]/, `${options.label}: interrupted-run error count was not visible`)
  assert.match(interruptedRunText, /Last forensic error:\s*.*\[redacted\]/, `${options.label}: forensic error did not stay redacted`)
  assert.match(actionsText, /Refresh diagnostics/, `${options.label}: recovery actions lost refresh diagnostics`)
  assert.match(actionsText, /Open resume controls/, `${options.label}: recovery actions lost resume controls`)
  assert.match(commandsText, /\/gsd doctor/, `${options.label}: recovery commands lost scoped doctor guidance`)
  assert.ok(
    actionIds.includes("command-surface-recovery-action-refresh_diagnostics"),
    `${options.label}: refresh_diagnostics button test id was missing`,
  )
  assert.ok(
    actionIds.includes("command-surface-recovery-action-open_resume_controls"),
    `${options.label}: open_resume_controls button test id was missing`,
  )
  assert.doesNotMatch(panelText, new RegExp(escapeRegExp(options.leakedSecret)), `${options.label}: recovery panel leaked a seeded secret`)
  assert.doesNotMatch(panelText, /Crash Recovery Briefing|Completed Tool Calls|toolCallId/, `${options.label}: recovery panel leaked raw transcript forensics`)
}

async function openResumeControlsFromRecovery(
  page: Page,
  options: {
    label: string
    expectedSessionName: string
    expectedAlternateSessionName: string
  },
): Promise<void> {
  await waitForGetResponse(page, {
    label: `${options.label} session browser load`,
    pathname: "/api/session/browser",
    action: () => page.locator('[data-testid="command-surface-recovery-action-open_resume_controls"]').click(),
  })
  await assertCommandSurfaceOpen(page, {
    label: `${options.label} session browser surface`,
    panelTestId: "command-surface-resume",
  })

  const metaText = (await page.locator('[data-testid="command-surface-session-browser-meta"]').textContent()) ?? ""
  const resultsText = (await page.locator('[data-testid="command-surface-session-browser-results"]').textContent()) ?? ""
  const resultCount = await page.locator('[data-testid^="command-surface-session-browser-item-"]').count()
  assert.match(metaText, /current-project sessions/i, `${options.label}: session browser lost current-project metadata`)
  assert.ok(resultCount >= 2, `${options.label}: expected at least two seeded current-project session results`)
  assert.match(resultsText, new RegExp(escapeRegExp(options.expectedSessionName)), `${options.label}: missing interrupted-run session result`)
  assert.match(resultsText, new RegExp(escapeRegExp(options.expectedAlternateSessionName)), `${options.label}: missing alternate recovery session result`)
}

async function assertCommandSurfaceOpen(
  page: Page,
  options: {
    label: string
    panelTestId: string
  },
): Promise<void> {
  try {
    await page.waitForSelector('[data-testid="command-surface"]', { state: "visible", timeout: 20_000 })
    await page.waitForSelector(`[data-testid="${options.panelTestId}"]`, { state: "visible", timeout: 20_000 })
  } catch {
    assert.fail(
      `${options.label}: expected command-surface and ${options.panelTestId} to become visible`,
    )
  }
}

test("gsd --web survives page reload and page reopen without losing current-project truth", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs")
    return
  }

  const launchCwd = process.cwd()
  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-runtime-"))
  const tempHome = join(tempRoot, "home")
  let port: number | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  try {
    writePreseededAuthFile(tempHome)

    const launch = await launchPackagedWebHost({
      launchCwd,
      tempHome,
    })
    port = launch.port

    assert.equal(launch.exitCode, 0, `expected the web launcher to exit cleanly:\n${launch.stderr}`)
    assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr")
    assert.ok(launch.stdout.trim().length === 0, `web launch should not emit interactive stdout: ${launch.stdout}`)
    await assertBrowserOpenAttempt(launch.browserLogPath, launch.url)

    const expectedProjectCwd = canonicalizePath(launchCwd)
    const expectedSessionsDirs = expectedRuntimeSessionsDirs(expectedProjectCwd, tempHome)
    browser = await chromium.launch({ headless: true })
    await waitForHttpOk(`${launch.url}/api/boot`)

    const page = await browser.newPage()
    const initial = await waitForLaunchedHostReady<RuntimeBootPayload>(page, {
      label: "initial repo-root attach",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => page.goto(launch.url, { waitUntil: "load" }),
    })

    assert.match(initial.bootResult.boot.workspace.active.milestoneId ?? "", /^M\d+$/, "expected a live active milestone id")
    if ((initial.bootResult.boot.workspace.active.sliceId ?? "").length > 0) {
      assert.match(initial.bootResult.boot.workspace.active.sliceId ?? "", /^S\d+$/)
    }
    assert.equal(typeof initial.bootResult.boot.workspace.active.phase, "string")
    assert.ok((initial.bootResult.boot.workspace.active.phase ?? "").length > 0, "expected a non-empty active workspace phase")

    const initialScope = initial.visible.scopeLabel ?? ""
    const initialSessionId = initial.bootResult.boot.bridge.activeSessionId ?? ""
    const initialEvent = initial.firstEvent as BridgeStatusEvent
    assert.equal(initialEvent.bridge.activeSessionId, initialSessionId, "initial attach should agree on the active session id")

    const reloaded = await waitForLaunchedHostReady<RuntimeBootPayload>(page, {
      label: "reload reconnect continuity",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => page.reload({ waitUntil: "load" }),
    })
    const reloadEvent = reloaded.firstEvent as BridgeStatusEvent
    assert.equal(reloaded.bootResult.boot.bridge.activeSessionId, initialSessionId, "reload should preserve the active session id")
    assert.equal(reloadEvent.bridge.activeSessionId, initialSessionId, "reload SSE attach should report the same active session id")
    assert.equal(reloaded.visible.scopeLabel, initialScope, "reload should preserve the same visible workspace scope")
    assert.equal(reloaded.visible.projectPathTitle, expectedProjectCwd, "reload should preserve the visible project path")

    await page.close()

    const reopenedPage = await browser.newPage()
    const reopened = await waitForLaunchedHostReady<RuntimeBootPayload>(reopenedPage, {
      label: "new page reopen continuity",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => reopenedPage.goto(launch.url, { waitUntil: "load" }),
    })
    const reopenEvent = reopened.firstEvent as BridgeStatusEvent
    assert.equal(reopened.bootResult.boot.bridge.activeSessionId, initialSessionId, "page reopen should preserve the active session id")
    assert.equal(reopenEvent.bridge.activeSessionId, initialSessionId, "page reopen SSE attach should report the same active session id")
    assert.equal(reopened.visible.scopeLabel, initialScope, "page reopen should preserve the same visible workspace scope")
    assert.equal(reopened.visible.projectPathTitle, expectedProjectCwd, "page reopen should preserve the visible project path")
  } finally {
    await browser?.close().catch(() => undefined)
    if (port !== null) {
      await killProcessOnPort(port)
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("real packaged browser shell keeps daily-use slash and click controls live", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs")
    return
  }

  const launchCwd = process.cwd()
  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-runtime-parity-"))
  const tempHome = join(tempRoot, "home")
  let port: number | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  try {
    writePreseededAuthFile(tempHome)
    seedCurrentProjectSession({
      projectCwd: launchCwd,
      baseSessionsDir: join(tempHome, ".gsd", "sessions"),
      sessionId: "sess-parity-seeded",
      name: "Seeded Browser Session",
      baseTimestamp: "2026-03-15T03:10:00.000Z",
    })

    const launch = await launchPackagedWebHost({
      launchCwd,
      tempHome,
    })
    port = launch.port

    assert.equal(launch.exitCode, 0, `expected the web launcher to exit cleanly:\n${launch.stderr}`)
    assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr")
    await assertBrowserOpenAttempt(launch.browserLogPath, launch.url)

    const expectedProjectCwd = canonicalizePath(launchCwd)
    const expectedSessionsDirs = expectedRuntimeSessionsDirs(expectedProjectCwd, tempHome)
    browser = await chromium.launch({ headless: true })
    await waitForHttpOk(`${launch.url}/api/boot`)
    const page = await browser.newPage()

    await waitForLaunchedHostReady<RuntimeBootPayload>(page, {
      label: "daily-use browser parity attach",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => page.goto(launch.url, { waitUntil: "load" }),
    })

    // Dashboard recovery entrypoint was removed (commit ea61412) — skip straight to command tests

    await waitForCommandResponse(page, {
      label: "/new built-in execution",
      type: "new_session",
      action: () => submitTerminalInput(page, "/new"),
    })
    await waitForTerminalLine(page, "Started a new session", "/new built-in execution")

    await submitTerminalInput(page, "/share")
    await waitForTerminalLine(page, "blocked instead of falling through to the model", "/share reject notice")

    await waitForCommandResponse(page, {
      label: "/model browser surface",
      type: "get_available_models",
      action: () => submitTerminalInput(page, "/model"),
    })
    await assertCommandSurfaceOpen(page, {
      label: "/model browser surface",
      panelTestId: "command-surface-models",
    })
    await page.waitForSelector('[data-testid="command-surface-apply-model"]', { state: "visible", timeout: 20_000 })
    await closeCommandSurfaceIfOpen(page, "/model browser surface")

    await submitTerminalInput(page, "/thinking")
    await assertCommandSurfaceOpen(page, {
      label: "/thinking browser surface",
      panelTestId: "command-surface-thinking",
    })
    await page.waitForSelector('[data-testid="command-surface-apply-thinking"]', { state: "visible", timeout: 20_000 })
    await closeCommandSurfaceIfOpen(page, "/thinking browser surface")

    await waitForGetResponse(page, {
      label: "/resume browser surface",
      pathname: "/api/session/browser",
      action: () => submitTerminalInput(page, "/resume"),
    })
    await assertCommandSurfaceOpen(page, {
      label: "/resume browser surface",
      panelTestId: "command-surface-resume",
    })
    assert.match(
      (await page.locator('[data-testid="command-surface-session-browser-meta"]').textContent()) ?? "",
      /current-project sessions/i,
      "/resume browser surface: expected current-project session-browser metadata",
    )
    const resumeResultCount = await page.locator('[data-testid^="command-surface-session-browser-item-"]').count()
    assert.ok(resumeResultCount >= 1, "/resume browser surface: expected at least one current-project session result")
    await closeCommandSurfaceIfOpen(page, "/resume browser surface")

    await waitForCommandResponse(page, {
      label: "/fork browser surface",
      type: "get_fork_messages",
      action: () => submitTerminalInput(page, "/fork"),
    })
    await assertCommandSurfaceOpen(page, {
      label: "/fork browser surface",
      panelTestId: "command-surface-fork",
    })
    await page.waitForSelector('[data-testid="command-surface-apply-fork"]', { state: "visible", timeout: 20_000 })
    const forkResultText = (await page.locator('[data-testid="command-surface-result"]').textContent().catch(() => null)) ?? ""
    const forkPanelText = (await page.locator('[data-testid="command-surface-fork"]').textContent()) ?? ""
    const forkOptionCount = await page.locator('[data-testid="command-surface-fork"] button').count()
    assert.ok(
      /Loaded \d+ fork points\.|No fork points are available yet\./.test(forkResultText) ||
        forkPanelText.includes("No user messages are available for forking yet.") ||
        forkOptionCount >= 1,
      "/fork browser surface: expected an explicit empty state, a loaded result notice, or visible fork options",
    )
    await closeCommandSurfaceIfOpen(page, "/fork browser surface")

    await waitForCommandResponse(page, {
      label: "/session browser surface",
      type: "get_session_stats",
      action: () => submitTerminalInput(page, "/session"),
    })
    await assertCommandSurfaceOpen(page, {
      label: "/session browser surface",
      panelTestId: "command-surface-session",
    })
    await page.waitForSelector('[data-testid="command-surface-export-session"]', { state: "visible", timeout: 20_000 })
    assert.match(
      (await page.locator('[data-testid="command-surface-result"]').textContent()) ?? "",
      /Loaded session details for /,
      "/session browser surface: expected a visible loaded-session notice",
    )
    await closeCommandSurfaceIfOpen(page, "/session browser surface")

    await submitTerminalInput(page, "/compact preserve the open blockers")
    await assertCommandSurfaceOpen(page, {
      label: "/compact browser surface",
      panelTestId: "command-surface-compact",
    })
    assert.equal(
      await page.locator('[data-testid="command-surface-compact-instructions"]').inputValue(),
      "preserve the open blockers",
      "/compact browser surface: expected slash args to seed the custom instructions field",
    )
    await closeCommandSurfaceIfOpen(page, "/compact browser surface")

    await submitTerminalInput(page, "/settings")
    await assertCommandSurfaceOpen(page, {
      label: "/settings browser surface",
      panelTestId: "command-surface-models",
    })
    await page.locator('[data-testid="command-surface-section-auth"]').click()
    await page.waitForSelector('[data-testid="command-surface-auth"]', { state: "visible", timeout: 20_000 })
    await closeCommandSurfaceIfOpen(page, "/settings browser surface")

    await page.locator('[data-testid="sidebar-settings-button"]').click()
    await assertCommandSurfaceOpen(page, {
      label: "sidebar settings click",
      panelTestId: "command-surface-models",
    })
    await closeCommandSurfaceIfOpen(page, "sidebar settings click")

    await submitTerminalInput(page, "/login")
    await assertCommandSurfaceOpen(page, {
      label: "/login browser surface",
      panelTestId: "command-surface-auth",
    })
    await page.waitForSelector('[data-testid="command-surface-logout-provider"]', { state: "visible", timeout: 20_000 })
    await closeCommandSurfaceIfOpen(page, "/login browser surface")

    await submitTerminalInput(page, "/logout")
    await assertCommandSurfaceOpen(page, {
      label: "/logout browser surface",
      panelTestId: "command-surface-auth",
    })
    await page.waitForSelector('[data-testid="command-surface-logout-provider"]', { state: "visible", timeout: 20_000 })
    await closeCommandSurfaceIfOpen(page, "/logout browser surface")

    await waitForGetResponse(page, {
      label: "sidebar git click",
      pathname: "/api/git",
      action: () => page.locator('[data-testid="sidebar-git-button"]').click(),
    })
    await assertCommandSurfaceOpen(page, {
      label: "sidebar git click",
      panelTestId: "command-surface-git-summary",
    })
    assert.ok(
      ((await page.locator('[data-testid="command-surface-git-state"]').textContent()) ?? "").trim().length > 0,
      "sidebar git click: expected a visible git-state summary",
    )
    await closeCommandSurfaceIfOpen(page, "sidebar git click")

    await waitForGetResponse(page, {
      label: "sidebar recovery entrypoint",
      pathname: "/api/recovery",
      action: () => page.locator('[data-testid="sidebar-recovery-summary-entrypoint"]').click(),
    })
    await assertCommandSurfaceOpen(page, {
      label: "sidebar recovery entrypoint",
      panelTestId: "command-surface-recovery",
    })
    await page.waitForSelector('[data-testid="command-surface-recovery-action-refresh_diagnostics"]', { state: "visible", timeout: 20_000 })
    await waitForGetResponse(page, {
      label: "sidebar recovery refresh action",
      pathname: "/api/recovery",
      action: () => page.locator('[data-testid="command-surface-recovery-action-refresh_diagnostics"]').click(),
    })
    await page.waitForSelector('[data-testid="command-surface-recovery-state"]', { state: "visible", timeout: 20_000 })
  } finally {
    await browser?.close().catch(() => undefined)
    if (port !== null) {
      await killProcessOnPort(port)
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("real packaged browser recovery stays redacted and actionable for a seeded interrupted-run project across reload and reopen", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs")
    return
  }

  const fixture = makeInterruptedRunRuntimeFixture()
  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-runtime-recovery-home-"))
  const tempHome = join(tempRoot, "home")
  let port: number | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  try {
    writePreseededAuthFile(tempHome)
    const seeded = seedInterruptedRunRecoverySessions({
      projectCwd: fixture.projectCwd,
      baseSessionsDir: join(tempHome, ".gsd", "sessions"),
    })

    const launch = await launchPackagedWebHost({
      launchCwd: fixture.projectCwd,
      tempHome,
    })
    port = launch.port

    assert.equal(launch.exitCode, 0, `expected the recovery fixture web launcher to exit cleanly:\n${launch.stderr}`)
    assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr for the recovery fixture launch")
    await assertBrowserOpenAttempt(launch.browserLogPath, launch.url)

    const expectedProjectCwd = canonicalizePath(fixture.projectCwd)
    const expectedSessionsDirs = expectedRuntimeSessionsDirs(expectedProjectCwd, tempHome)
    browser = await chromium.launch({ headless: true })
    await waitForHttpOk(`${launch.url}/api/boot`)
    const page = await browser.newPage()

    const initial = await waitForLaunchedHostReady<RuntimeBootPayload>(page, {
      label: "seeded interrupted-run cold start",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => page.goto(launch.url, { waitUntil: "load" }),
    })
    assert.match(initial.visible.scopeLabel ?? "", new RegExp(escapeRegExp(fixture.expectedScope)), "cold start should expose the seeded recovery scope")
    await openRecoveryPanel(page)
    await assertRecoveryPanel(page, {
      label: "initial seeded recovery diagnostics",
      expectedScope: fixture.expectedScope,
      leakedSecret: seeded.leakedSecret,
    })
    const initialRecovery = await waitForJsonGetResponse<RuntimeRecoveryPayload>(page, {
      label: "initial seeded recovery refresh",
      pathname: "/api/recovery",
      action: () => page.locator('[data-testid="command-surface-recovery-action-refresh_diagnostics"]').click(),
    })
    assertRecoveryPayload(initialRecovery, {
      label: "initial seeded recovery refresh",
      expectedScope: fixture.expectedScope,
      expectedSessionId: seeded.activeSession.sessionId,
      leakedSecret: seeded.leakedSecret,
    })
    await openResumeControlsFromRecovery(page, {
      label: "initial seeded recovery",
      expectedSessionName: seeded.activeSession.name,
      expectedAlternateSessionName: seeded.alternateSession.name,
    })
    await closeCommandSurfaceIfOpen(page, "initial seeded recovery")

    const reloaded = await waitForLaunchedHostReady<RuntimeBootPayload>(page, {
      label: "seeded interrupted-run reload",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => page.reload({ waitUntil: "load" }),
    })
    await openRecoveryPanel(page)
    await assertRecoveryPanel(page, {
      expectedScope: fixture.expectedScope,
      leakedSecret: seeded.leakedSecret,
    })
    const reloadedRecovery = await waitForJsonGetResponse<RuntimeRecoveryPayload>(page, {
      label: "reloaded seeded recovery refresh",
      pathname: "/api/recovery",
      action: () => page.locator('[data-testid="command-surface-recovery-action-refresh_diagnostics"]').click(),
    })
    assertRecoveryPayload(reloadedRecovery, {
      label: "reloaded seeded recovery refresh",
      expectedScope: fixture.expectedScope,
      expectedSessionId: seeded.activeSession.sessionId,
      leakedSecret: seeded.leakedSecret,
    })
    await openResumeControlsFromRecovery(page, {
      label: "reloaded seeded recovery",
      expectedSessionName: seeded.activeSession.name,
      expectedAlternateSessionName: seeded.alternateSession.name,
    })
    await closeCommandSurfaceIfOpen(page, "reloaded seeded recovery")

    await page.close()

    const reopenedPage = await browser.newPage()
    const reopened = await waitForLaunchedHostReady<RuntimeBootPayload>(reopenedPage, {
      label: "seeded interrupted-run reopen",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => reopenedPage.goto(launch.url, { waitUntil: "load" }),
    })
    await openRecoveryPanel(reopenedPage)
    await assertRecoveryPanel(reopenedPage, {
      expectedScope: fixture.expectedScope,
      leakedSecret: seeded.leakedSecret,
    })
    const reopenedRecovery = await waitForJsonGetResponse<RuntimeRecoveryPayload>(reopenedPage, {
      label: "reopened seeded recovery refresh",
      pathname: "/api/recovery",
      action: () => reopenedPage.locator('[data-testid="command-surface-recovery-action-refresh_diagnostics"]').click(),
    })
    assertRecoveryPayload(reopenedRecovery, {
      label: "reopened seeded recovery refresh",
      expectedScope: fixture.expectedScope,
      expectedSessionId: seeded.activeSession.sessionId,
      leakedSecret: seeded.leakedSecret,
    })
    await openResumeControlsFromRecovery(reopenedPage, {
      label: "reopened seeded recovery",
      expectedSessionName: seeded.activeSession.name,
      expectedAlternateSessionName: seeded.alternateSession.name,
    })
    await closeCommandSurfaceIfOpen(reopenedPage, "reopened seeded recovery")
  } finally {
    await browser?.close().catch(() => undefined)
    if (port !== null) {
      await killProcessOnPort(port)
    }
    rmSync(tempRoot, { recursive: true, force: true })
    fixture.cleanup()
  }
})

test("shared launched-host harness can target a seeded fixture cwd instead of silently reusing repo root", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs")
    return
  }

  const fixture = makeRuntimeWorkspaceFixture()
  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-runtime-fixture-home-"))
  const tempHome = join(tempRoot, "home")
  let port: number | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  try {
    writePreseededAuthFile(tempHome)

    const launch = await launchPackagedWebHost({
      launchCwd: fixture.projectCwd,
      tempHome,
    })
    port = launch.port

    assert.equal(launch.exitCode, 0, `expected the fixture web launcher to exit cleanly:\n${launch.stderr}`)
    assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr for the fixture launch")
    await assertBrowserOpenAttempt(launch.browserLogPath, launch.url)

    const expectedProjectCwd = canonicalizePath(fixture.projectCwd)
    const expectedSessionsDirs = expectedRuntimeSessionsDirs(expectedProjectCwd, tempHome)
    browser = await chromium.launch({ headless: true })
    await waitForHttpOk(`${launch.url}/api/boot`)
    const page = await browser.newPage()
    const fixtureProof = await waitForLaunchedHostReady<RuntimeBootPayload>(page, {
      label: "fixture cwd cold start",
      expectedProjectCwd,
      expectedSessionsDir: expectedSessionsDirs,
      launchStderr: launch.stderr,
      navigation: () => page.goto(launch.url, { waitUntil: "load" }),
    })

    assert.notEqual(fixtureProof.bootResult.boot.project.cwd, process.cwd(), "fixture launch should not fall back to the repo-root project cwd")
    assert.match(fixtureProof.visible.scopeLabel ?? "", new RegExp(escapeRegExp(fixture.expectedScope)), "fixture launch should expose the seeded fixture scope")
    const fixtureEvent = fixtureProof.firstEvent as BridgeStatusEvent
    assert.equal(fixtureEvent.bridge.phase, "ready")
  } finally {
    await browser?.close().catch(() => undefined)
    if (port !== null) {
      await killProcessOnPort(port)
    }
    rmSync(tempRoot, { recursive: true, force: true })
    fixture.cleanup()
  }
})
