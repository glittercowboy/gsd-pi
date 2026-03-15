import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const { BUILTIN_SLASH_COMMANDS } = await import("../../packages/pi-coding-agent/src/core/slash-commands.ts")
const {
  dispatchBrowserSlashCommand,
  getBrowserSlashCommandTerminalNotice,
} = await import("../../web/lib/browser-slash-command-dispatch.ts")
const {
  applyCommandSurfaceActionResult,
  createInitialCommandSurfaceState,
  openCommandSurfaceState,
  setCommandSurfacePending,
  surfaceOutcomeToOpenRequest,
} = await import("../../web/lib/command-surface-contract.ts")
const gsdExtension = await import("../resources/extensions/gsd/index.ts")

const EXPECTED_BUILTIN_OUTCOMES = new Map<string, "rpc" | "surface" | "reject">([
  ["settings", "surface"],
  ["model", "surface"],
  ["scoped-models", "reject"],
  ["export", "surface"],
  ["share", "reject"],
  ["copy", "reject"],
  ["name", "surface"],
  ["session", "surface"],
  ["changelog", "reject"],
  ["hotkeys", "reject"],
  ["fork", "surface"],
  ["tree", "reject"],
  ["login", "surface"],
  ["logout", "surface"],
  ["new", "rpc"],
  ["compact", "surface"],
  ["resume", "surface"],
  ["reload", "reject"],
  ["thinking", "surface"],
  ["quit", "reject"],
])

const BUILTIN_DESCRIPTIONS = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command.description]))
const DEFERRED_BROWSER_REJECTS = ["share", "copy", "changelog", "hotkeys", "tree", "reload", "quit"] as const

function collectRegisteredGsdCommandRoots(): string[] {
  const commands = new Map<string, unknown>()

  gsdExtension.default({
    registerCommand(name: string, options: unknown) {
      commands.set(name, options)
    },
    registerTool() {
      // not needed for this contract test
    },
    registerShortcut() {
      // not needed for this contract test
    },
    on() {
      // not needed for this contract test
    },
  } as any)

  return [...commands.keys()].sort()
}

function assertPromptPassthrough(
  input: string,
  options: { isStreaming?: boolean; expectedType?: "prompt" | "follow_up" } = {},
): void {
  const outcome = dispatchBrowserSlashCommand(input, { isStreaming: options.isStreaming })
  assert.equal(outcome.kind, "prompt", `${input} should stay on the prompt/extension path, got ${outcome.kind}`)
  assert.equal(
    outcome.command.type,
    options.expectedType ?? (options.isStreaming ? "follow_up" : "prompt"),
    `${input} should preserve its prompt command type`,
  )
  assert.equal(outcome.command.message, input, `${input} should preserve the exact prompt text for extension dispatch`)
}

test("authoritative built-ins never fall through to prompt/follow_up in browser mode", async (t) => {
  assert.equal(
    EXPECTED_BUILTIN_OUTCOMES.size,
    BUILTIN_SLASH_COMMANDS.length,
    "update EXPECTED_BUILTIN_OUTCOMES when slash-commands.ts changes so browser parity stays explicit",
  )

  for (const builtin of BUILTIN_SLASH_COMMANDS) {
    await t.test(`/${builtin.name} -> ${EXPECTED_BUILTIN_OUTCOMES.get(builtin.name)}`, () => {
      const outcome = dispatchBrowserSlashCommand(`/${builtin.name}`)
      const expectedKind = EXPECTED_BUILTIN_OUTCOMES.get(builtin.name)

      assert.ok(expectedKind, `missing explicit browser expectation for /${builtin.name}`)
      assert.notEqual(
        outcome.kind,
        "prompt",
        `/${builtin.name} must not fall through to prompt/follow_up in browser mode`,
      )
      assert.equal(outcome.kind, expectedKind, `/${builtin.name} resolved to ${outcome.kind}`)

      if (outcome.kind === "reject") {
        const notice = getBrowserSlashCommandTerminalNotice(outcome)
        assert.ok(notice, `/${builtin.name} should produce a browser-visible reject notice`)
        assert.equal(notice.type, "error", `/${builtin.name} reject notice should be an error line`)
        assert.match(notice.message, new RegExp(`/${builtin.name}`), `/${builtin.name} notice should name the command`)
        assert.match(notice.message, /blocked instead of falling through to the model/i)
      }
    })
  }
})

test("browser-local aliases and legacy helpers stay explicit", async (t) => {
  const explicitCases = [
    { input: "/state", expectedKind: "rpc", expectedCommandType: "get_state" },
    { input: "/new-session", expectedKind: "rpc", expectedCommandType: "new_session" },
    { input: "/refresh", expectedKind: "local", expectedAction: "refresh_workspace" },
    { input: "/clear", expectedKind: "local", expectedAction: "clear_terminal" },
  ] as const

  for (const scenario of explicitCases) {
    await t.test(scenario.input, () => {
      const outcome = dispatchBrowserSlashCommand(scenario.input)
      assert.equal(outcome.kind, scenario.expectedKind, `${scenario.input} resolved to ${outcome.kind}`)

      if (outcome.kind === "rpc") {
        assert.equal(outcome.command.type, scenario.expectedCommandType)
      }

      if (outcome.kind === "local") {
        assert.equal(outcome.action, scenario.expectedAction)
      }
    })
  }
})

test("registered GSD command roots stay on the prompt/extension path", () => {
  const registeredRoots = collectRegisteredGsdCommandRoots()
  assert.deepEqual(
    registeredRoots,
    ["exit", "gsd", "kill", "worktree", "wt"],
    "browser parity contract only expects the current GSD command roots",
  )

  for (const root of registeredRoots) {
    assertPromptPassthrough(`/${root}`)
  }
})

test("current GSD command family samples stay preserved instead of being swallowed or rejected", async (t) => {
  const samples = ["/gsd", "/gsd status", "/worktree list", "/wt list", "/kill", "/exit"]

  for (const sample of samples) {
    await t.test(sample, () => {
      assertPromptPassthrough(sample)
    })
  }

  await t.test("streaming sessions still preserve extension dispatch", () => {
    assertPromptPassthrough("/gsd status", { isStreaming: true, expectedType: "follow_up" })
  })
})

test("slash /settings and sidebar settings click open the same shared surface contract", () => {
  const currentContext = {
    onboardingLocked: false,
    currentModel: { provider: "openai", modelId: "gpt-5.4" },
    currentThinkingLevel: "medium",
    preferredProviderId: "openai",
  } as const

  const slashOutcome = dispatchBrowserSlashCommand("/settings")
  assert.equal(slashOutcome.kind, "surface")

  const slashState = openCommandSurfaceState(
    createInitialCommandSurfaceState(),
    surfaceOutcomeToOpenRequest(slashOutcome, currentContext),
  )
  const clickState = openCommandSurfaceState(createInitialCommandSurfaceState(), {
    surface: "settings",
    source: "sidebar",
    ...currentContext,
  })

  assert.equal(slashState.open, true)
  assert.equal(clickState.open, true)
  assert.equal(slashState.activeSurface, "settings")
  assert.equal(clickState.activeSurface, "settings")
  assert.equal(slashState.section, clickState.section)
  assert.deepEqual(slashState.selectedTarget, clickState.selectedTarget)
  assert.equal(slashState.selectedTarget?.kind, "settings")
})

test("session-oriented slash surfaces open the correct sections and carry actionable targets", async (t) => {
  const context = {
    onboardingLocked: false,
    currentModel: { provider: "openai", modelId: "gpt-5.4" },
    currentThinkingLevel: "medium",
    preferredProviderId: "openai",
    currentSessionPath: "/tmp/sessions/active.jsonl",
    currentSessionName: "Active session",
    projectCwd: "/tmp/project",
    projectSessionsDir: "/tmp/sessions",
    resumableSessions: [
      { id: "sess-active", path: "/tmp/sessions/active.jsonl", name: "Active session", isActive: true },
      { id: "sess-next", path: "/tmp/sessions/next.jsonl", name: "Next session", isActive: false },
    ],
  } as const

  const cases = [
    {
      input: "/resume",
      expectedSection: "resume",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "resume", sessionPath: "/tmp/sessions/next.jsonl" })
      },
    },
    {
      input: "/resume next",
      expectedSection: "resume",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "resume", sessionPath: "/tmp/sessions/next.jsonl" })
      },
    },
    {
      input: "/name",
      expectedSection: "name",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "name", sessionPath: "/tmp/sessions/active.jsonl", name: "Active session" })
      },
    },
    {
      input: "/name Ship It",
      expectedSection: "name",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "name", sessionPath: "/tmp/sessions/active.jsonl", name: "Ship It" })
      },
    },
    {
      input: "/fork",
      expectedSection: "fork",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "fork", entryId: undefined })
      },
    },
    {
      input: "/session",
      expectedSection: "session",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "session", outputPath: undefined })
      },
    },
    {
      input: "/export ./artifacts/session.html",
      expectedSection: "session",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "session", outputPath: "./artifacts/session.html" })
      },
    },
    {
      input: "/compact preserve the open blockers",
      expectedSection: "compact",
      assertTarget(target: unknown) {
        assert.deepEqual(target, { kind: "compact", customInstructions: "preserve the open blockers" })
      },
    },
  ] as const

  for (const scenario of cases) {
    await t.test(scenario.input, () => {
      const outcome = dispatchBrowserSlashCommand(scenario.input)
      assert.equal(outcome.kind, "surface")

      const state = openCommandSurfaceState(
        createInitialCommandSurfaceState(),
        surfaceOutcomeToOpenRequest(outcome, context),
      )

      assert.equal(state.section, scenario.expectedSection)
      scenario.assertTarget(state.selectedTarget)
    })
  }
})

test("session browser surfaces seed current-project query state and rename draft state", () => {
  const resumeState = openCommandSurfaceState(createInitialCommandSurfaceState(), {
    surface: "resume",
    source: "slash",
    args: "next",
    currentSessionPath: "/tmp/sessions/active.jsonl",
    currentSessionName: "Active session",
    projectCwd: "/tmp/project",
    projectSessionsDir: "/tmp/sessions",
    resumableSessions: [
      { id: "sess-active", path: "/tmp/sessions/active.jsonl", name: "Active session", isActive: true },
      { id: "sess-next", path: "/tmp/sessions/next.jsonl", name: "Next session", isActive: false },
    ],
  })

  assert.equal(resumeState.sessionBrowser.query, "next")
  assert.equal(resumeState.sessionBrowser.sortMode, "relevance")
  assert.equal(resumeState.sessionBrowser.nameFilter, "all")
  assert.equal(resumeState.sessionBrowser.projectCwd, "/tmp/project")
  assert.equal(resumeState.resumeRequest.pending, false)

  const renameState = openCommandSurfaceState(createInitialCommandSurfaceState(), {
    surface: "name",
    source: "slash",
    args: "Ship It",
    currentSessionPath: "/tmp/sessions/active.jsonl",
    currentSessionName: "Active session",
    projectCwd: "/tmp/project",
    projectSessionsDir: "/tmp/sessions",
  })

  assert.equal(renameState.sessionBrowser.query, "")
  assert.equal(renameState.sessionBrowser.sortMode, "threaded")
  assert.equal(renameState.sessionBrowser.projectSessionsDir, "/tmp/sessions")
  assert.deepEqual(renameState.selectedTarget, {
    kind: "name",
    sessionPath: "/tmp/sessions/active.jsonl",
    name: "Ship It",
  })
  assert.equal(renameState.renameRequest.pending, false)
})

test("session browser action state keeps resume and rename mutations inspectable", () => {
  const opened = openCommandSurfaceState(createInitialCommandSurfaceState(), {
    surface: "name",
    source: "slash",
    currentSessionPath: "/tmp/sessions/active.jsonl",
    currentSessionName: "Active session",
  })

  const renameTarget = { kind: "name", sessionPath: "/tmp/sessions/active.jsonl", name: "Ship It" } as const
  const renamePending = setCommandSurfacePending(opened, "rename_session", renameTarget)
  assert.deepEqual(renamePending.renameRequest, {
    pending: true,
    sessionPath: "/tmp/sessions/active.jsonl",
    result: null,
    error: null,
  })

  const renameFailed = applyCommandSurfaceActionResult(renamePending, {
    action: "rename_session",
    success: false,
    message: "Bridge rename failed",
    selectedTarget: renameTarget,
  })
  assert.equal(renameFailed.renameRequest.pending, false)
  assert.equal(renameFailed.renameRequest.error, "Bridge rename failed")

  const resumeTarget = { kind: "resume", sessionPath: "/tmp/sessions/next.jsonl" } as const
  const resumePending = setCommandSurfacePending(renameFailed, "switch_session", resumeTarget)
  assert.deepEqual(resumePending.resumeRequest, {
    pending: true,
    sessionPath: "/tmp/sessions/next.jsonl",
    result: null,
    error: null,
  })

  const resumed = applyCommandSurfaceActionResult(resumePending, {
    action: "switch_session",
    success: true,
    message: "Switched to Next session",
    selectedTarget: resumeTarget,
  })
  assert.equal(resumed.resumeRequest.pending, false)
  assert.equal(resumed.resumeRequest.result, "Switched to Next session")
  assert.equal(resumed.renameRequest.error, "Bridge rename failed")
})

test("deferred built-ins expose explicit rejection reasons in the browser", async (t) => {
  for (const commandName of DEFERRED_BROWSER_REJECTS) {
    await t.test(`/${commandName}`, () => {
      const outcome = dispatchBrowserSlashCommand(`/${commandName}`)
      assert.equal(outcome.kind, "reject")
      assert.equal(
        outcome.reason,
        `/${commandName} is a built-in pi command (${BUILTIN_DESCRIPTIONS.get(commandName)}) that is not available in the browser yet.`,
      )
      assert.equal(outcome.guidance, "It was blocked instead of falling through to the model.")

      const notice = getBrowserSlashCommandTerminalNotice(outcome)
      assert.ok(notice)
      assert.match(notice.message, new RegExp(`/${commandName}`))
      assert.match(notice.message, /not available in the browser yet/i)
    })
  }
})

test("surface action state keeps session failures and recoveries inspectable", () => {
  const opened = openCommandSurfaceState(createInitialCommandSurfaceState(), {
    surface: "session",
    source: "slash",
  })

  const pending = setCommandSurfacePending(opened, "load_session_stats", {
    kind: "session",
    outputPath: "./session.html",
  })
  const failed = applyCommandSurfaceActionResult(pending, {
    action: "load_session_stats",
    success: false,
    message: "Bridge unavailable while loading session stats",
    selectedTarget: {
      kind: "session",
      outputPath: "./session.html",
    },
    sessionStats: null,
  })

  assert.equal(failed.pendingAction, null)
  assert.equal(failed.lastResult, null)
  assert.equal(failed.lastError, "Bridge unavailable while loading session stats")
  assert.equal(failed.sessionStats, null)
  assert.deepEqual(failed.selectedTarget, {
    kind: "session",
    outputPath: "./session.html",
  })

  const recovered = applyCommandSurfaceActionResult(
    setCommandSurfacePending(failed, "load_session_stats", failed.selectedTarget),
    {
      action: "load_session_stats",
      success: true,
      message: "Loaded session details for sess-1",
      selectedTarget: failed.selectedTarget,
      sessionStats: {
        sessionFile: "/tmp/sessions/sess-1.jsonl",
        sessionId: "sess-1",
        userMessages: 4,
        assistantMessages: 4,
        toolCalls: 2,
        toolResults: 2,
        totalMessages: 12,
        tokens: {
          input: 1200,
          output: 3400,
          cacheRead: 0,
          cacheWrite: 0,
          total: 4600,
        },
        cost: 0.34,
      },
    },
  )

  assert.equal(recovered.lastError, null)
  assert.equal(recovered.lastResult, "Loaded session details for sess-1")
  assert.equal(recovered.sessionStats?.sessionId, "sess-1")
  assert.equal(recovered.sessionStats?.tokens.total, 4600)
})

test("surface action state keeps compaction summaries inspectable", () => {
  const opened = openCommandSurfaceState(createInitialCommandSurfaceState(), {
    surface: "compact",
    source: "slash",
    args: "preserve blockers",
  })

  const pending = setCommandSurfacePending(opened, "compact_session", {
    kind: "compact",
    customInstructions: "preserve blockers",
  })
  const succeeded = applyCommandSurfaceActionResult(pending, {
    action: "compact_session",
    success: true,
    message: "Compacted 14,200 tokens into a fresh summary with custom instructions.",
    selectedTarget: {
      kind: "compact",
      customInstructions: "preserve blockers",
    },
    lastCompaction: {
      summary: "Summary of the kept work",
      firstKeptEntryId: "entry-17",
      tokensBefore: 14_200,
    },
  })

  assert.equal(succeeded.lastError, null)
  assert.equal(succeeded.lastResult, "Compacted 14,200 tokens into a fresh summary with custom instructions.")
  assert.equal(succeeded.lastCompaction?.firstKeptEntryId, "entry-17")
  assert.equal(succeeded.lastCompaction?.summary, "Summary of the kept work")
})

test("clicked dashboard and command-surface session affordances use the shared store action path", () => {
  const dashboardPath = resolve(import.meta.dirname, "../../web/components/gsd/dashboard.tsx")
  const dashboardSource = readFileSync(dashboardPath, "utf-8")
  const commandSurfacePath = resolve(import.meta.dirname, "../../web/components/gsd/command-surface.tsx")
  const commandSurfaceSource = readFileSync(commandSurfacePath, "utf-8")

  assert.match(
    dashboardSource,
    /await submitInput\("\/new"\)/,
    "dashboard new-session control should reuse the shared slash-command submit path",
  )
  assert.match(
    dashboardSource,
    /await switchSessionFromSurface\(session\.path\)/,
    "dashboard session switch should reuse the shared session action path",
  )
  assert.match(
    commandSurfaceSource,
    /void switchSessionFromSurface\(selectedResumeTarget\.sessionPath\)/,
    "command-surface resume apply button should reuse the shared session-switch store action",
  )
  assert.match(
    commandSurfaceSource,
    /void renameSessionFromSurface\(selectedNameTarget\.sessionPath, selectedNameTarget\.name\)/,
    "command-surface rename apply button should reuse the shared session-rename store action",
  )
})
