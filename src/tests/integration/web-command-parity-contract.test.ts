import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const { BUILTIN_SLASH_COMMANDS } = await import("../../../packages/pi-coding-agent/src/core/slash-commands.ts")
const {
  dispatchBrowserSlashCommand,
  getBrowserSlashCommandTerminalNotice,
} = await import("../../../web/lib/browser-slash-command-dispatch.ts")
const {
  applyCommandSurfaceActionResult,
  createInitialCommandSurfaceState,
  openCommandSurfaceState,
  setCommandSurfacePending,
  surfaceOutcomeToOpenRequest,
} = await import("../../../web/lib/command-surface-contract.ts")
const gsdExtension = await import("../../resources/extensions/gsd/index.ts")

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
  ["provider", "reject"],
  ["login", "surface"],
  ["logout", "surface"],
  ["new", "rpc"],
  ["compact", "surface"],
  ["resume", "surface"],
  ["reload", "reject"],
  ["thinking", "surface"],
  ["edit-mode", "reject"],
  ["terminal", "reject"],
  ["quit", "reject"],
])

const BUILTIN_DESCRIPTIONS = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command.description]))
const DEFERRED_BROWSER_REJECTS = ["share", "copy", "changelog", "hotkeys", "tree", "provider", "reload", "edit-mode", "terminal", "quit"] as const

async function collectRegisteredGsdCommandRoots(): Promise<string[]> {
  const commands = new Map<string, unknown>()

  await gsdExtension.default({
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
    const expectedKind = EXPECTED_BUILTIN_OUTCOMES.get(builtin.name)
    const outcome = dispatchBrowserSlashCommand(`/${builtin.name}`)
    await t.test(`/${builtin.name} -> ${expectedKind}`, () => {
      assert.ok(expectedKind, `missing explicit browser expectation for /${builtin.name}`)
      assert.notEqual(
        outcome.kind,
        "prompt",
        `/${builtin.name} must not fall through to prompt/follow_up in browser mode`,
      )
      assert.equal(outcome.kind, expectedKind, `/${builtin.name} resolved to ${outcome.kind}`)
    })

    if (outcome.kind === "reject") {
      await t.test(`/${builtin.name} reject notice is browser-visible`, () => {
        const outcome = dispatchBrowserSlashCommand(`/${builtin.name}`)
        const notice = getBrowserSlashCommandTerminalNotice(outcome)
        assert.ok(notice, `/${builtin.name} should produce a browser-visible reject notice`)
        assert.equal(notice.type, "error", `/${builtin.name} reject notice should be an error line`)
        assert.match(notice.message, new RegExp(`/${builtin.name}`), `/${builtin.name} notice should name the command`)
        assert.match(notice.message, /blocked instead of falling through to the model/i)
      })
    }
  }
})

test("browser-local aliases and legacy helpers stay explicit", async (t) => {
  await t.test("/state dispatches to rpc get_state", () => {
    const outcome = dispatchBrowserSlashCommand("/state")
    assert.equal(outcome.kind, "rpc")
    assert.equal((outcome as any).command.type, "get_state")
  })

  await t.test("/new-session dispatches to rpc new_session", () => {
    const outcome = dispatchBrowserSlashCommand("/new-session")
    assert.equal(outcome.kind, "rpc")
    assert.equal((outcome as any).command.type, "new_session")
  })

  await t.test("/refresh dispatches to local refresh_workspace", () => {
    const outcome = dispatchBrowserSlashCommand("/refresh")
    assert.equal(outcome.kind, "local")
    assert.equal((outcome as any).action, "refresh_workspace")
  })

  await t.test("/clear dispatches to local clear_terminal", () => {
    const outcome = dispatchBrowserSlashCommand("/clear")
    assert.equal(outcome.kind, "local")
    assert.equal((outcome as any).action, "clear_terminal")
  })
})

test("registered GSD command roots stay on the prompt/extension path", async () => {
  const registeredRoots = await collectRegisteredGsdCommandRoots()
  assert.deepEqual(
    registeredRoots,
    ["exit", "gsd", "kill", "worktree", "wt"],
    "browser parity contract only expects the current GSD command roots",
  )

  // Non-gsd roots are extension commands that pass through to the bridge.
  // Derived dynamically so adding a new registration fails this assertion loudly.
  const nonGsdRoots = registeredRoots.filter((r) => r !== "gsd")
  assert.equal(nonGsdRoots.length, 4, "expected exactly 4 non-gsd passthrough roots; update this count when adding registrations")
  for (const root of nonGsdRoots) {
    assertPromptPassthrough(`/${root}`)
  }

  // Bare /gsd passes through to bridge (equivalent to /gsd next)
  const bareGsd = dispatchBrowserSlashCommand("/gsd")
  assert.equal(bareGsd.kind, "prompt", "bare /gsd should pass through to bridge")
  assert.equal(bareGsd.command.message, "/gsd", "bare /gsd should preserve exact input")
})

test("current GSD command family samples dispatch to correct outcomes after S02", async (t) => {
  await t.test("/gsd (bare) still passes through to bridge", () => {
    assertPromptPassthrough("/gsd")
  })

  await t.test("/gsd status now dispatches to surface", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd status")
    assert.equal(outcome.kind, "surface", "/gsd status should dispatch to surface after T01")
    assert.equal(outcome.surface, "gsd-status")
  })

  await t.test("/worktree list, /wt list, /kill, /exit still pass through", () => {
    assertPromptPassthrough("/worktree list")
    assertPromptPassthrough("/wt list")
    assertPromptPassthrough("/kill")
    assertPromptPassthrough("/exit")
  })

  await t.test("/gsd status dispatches to surface regardless of streaming state", () => {
    const streaming = dispatchBrowserSlashCommand("/gsd status", { isStreaming: true })
    assert.equal(streaming.kind, "surface", "/gsd status should be surface even when streaming")
    assert.equal(streaming.surface, "gsd-status")

    const idle = dispatchBrowserSlashCommand("/gsd status", { isStreaming: false })
    assert.equal(idle.kind, "surface")
    assert.equal(idle.surface, "gsd-status")
  })
})

const EXPECTED_GSD_OUTCOMES = new Map<string, "surface" | "prompt" | "local" | "view-navigate">([
  // Surface commands (19)
  ["status", "surface"],
  ["visualize", "view-navigate"],
  ["forensics", "surface"],
  ["doctor", "surface"],
  ["skill-health", "surface"],
  ["knowledge", "surface"],
  ["capture", "surface"],
  ["triage", "surface"],
  ["quick", "surface"],
  ["history", "surface"],
  ["undo", "surface"],
  ["inspect", "surface"],
  ["prefs", "surface"],
  ["config", "surface"],
  ["hooks", "surface"],
  ["mode", "surface"],
  ["steer", "surface"],
  ["export", "surface"],
  ["cleanup", "surface"],
  ["queue", "surface"],
  // Bridge passthrough (9)
  ["auto", "prompt"],
  ["next", "prompt"],
  ["stop", "prompt"],
  ["pause", "prompt"],
  ["skip", "prompt"],
  ["discuss", "prompt"],
  ["run-hook", "prompt"],
  ["migrate", "prompt"],
  ["remote", "prompt"],
  // Inline help
  ["help", "local"],
])

test("every registered /gsd subcommand has an explicit browser dispatch outcome", async (t) => {
  assert.equal(
    EXPECTED_GSD_OUTCOMES.size,
    30,
    "EXPECTED_GSD_OUTCOMES must cover all 30 GSD subcommands (19 surface + 1 view-navigate + 9 passthrough + 1 help)",
  )

  for (const [subcommand, expectedKind] of EXPECTED_GSD_OUTCOMES) {
    await t.test(`/gsd ${subcommand} -> ${expectedKind}`, () => {
      const outcome = dispatchBrowserSlashCommand(`/gsd ${subcommand}`)
      assert.equal(
        outcome.kind,
        expectedKind,
        `/gsd ${subcommand} should dispatch to ${expectedKind}, got ${outcome.kind}`,
      )
    })

    if (expectedKind === "surface") {
      await t.test(`/gsd ${subcommand} opens gsd-${subcommand} surface`, () => {
        const outcome = dispatchBrowserSlashCommand(`/gsd ${subcommand}`) as any
        assert.equal(outcome.surface, `gsd-${subcommand}`, `/gsd ${subcommand} should open the gsd-${subcommand} surface`)
      })
    }

    if (expectedKind === "prompt") {
      await t.test(`/gsd ${subcommand} preserves exact input text`, () => {
        const outcome = dispatchBrowserSlashCommand(`/gsd ${subcommand}`) as any
        assert.equal(outcome.command.message, `/gsd ${subcommand}`, `/gsd ${subcommand} should preserve exact input text for bridge delivery`)
      })
    }

    if (expectedKind === "local") {
      await t.test(`/gsd ${subcommand} dispatches to gsd_help action`, () => {
        const outcome = dispatchBrowserSlashCommand(`/gsd ${subcommand}`) as any
        assert.equal(outcome.action, "gsd_help", `/gsd ${subcommand} should dispatch to gsd_help action`)
      })
    }

    if (expectedKind === "view-navigate") {
      await t.test(`/gsd ${subcommand} navigates to the ${subcommand} view`, () => {
        const outcome = dispatchBrowserSlashCommand(`/gsd ${subcommand}`) as any
        assert.equal(outcome.view, subcommand, `/gsd ${subcommand} should navigate to the ${subcommand} view`)
      })
    }
  }
})

test("GSD dispatch edge cases", async (t) => {
  await t.test("/gsd (bare, no subcommand) passes through to bridge", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd")
    assert.equal(outcome.kind, "prompt")
    assert.equal(outcome.command.message, "/gsd")
  })

  await t.test("/gsd help dispatches to local gsd_help action", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd help")
    assert.equal(outcome.kind, "local")
    assert.equal(outcome.action, "gsd_help")
  })

  await t.test("/gsd unknown-xyz passes through to bridge", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd unknown-xyz")
    assert.equal(outcome.kind, "prompt", "unknown subcommand should pass through to bridge")
    assert.equal(outcome.command.message, "/gsd unknown-xyz", "unknown subcommand should preserve exact input")
    assert.equal(outcome.slashCommandName, "gsd", "unknown subcommand should identify as gsd command")
  })

  await t.test("/export is built-in session export, not gsd-export", () => {
    const outcome = dispatchBrowserSlashCommand("/export")
    assert.equal(outcome.kind, "surface")
    assert.equal(outcome.surface, "export", "/export should be the built-in session export surface")
  })

  await t.test("/gsd export is GSD milestone export, distinct from built-in /export", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd export")
    assert.equal(outcome.kind, "surface")
    assert.equal(outcome.surface, "gsd-export", "/gsd export should be the GSD milestone export surface")
  })

  await t.test("/gsd forensics detailed preserves sub-args", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd forensics detailed")
    assert.equal(outcome.kind, "surface")
    assert.equal(outcome.surface, "gsd-forensics")
    assert.equal(outcome.args, "detailed", "sub-args after subcommand should be preserved")
  })

  await t.test("GSD surface commands produce system terminal notice", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd status")
    const notice = getBrowserSlashCommandTerminalNotice(outcome)
    assert.ok(notice, "surface outcome should produce a terminal notice")
    assert.equal(notice.type, "system")
  })

  await t.test("GSD passthrough commands produce no terminal notice", () => {
    const outcome = dispatchBrowserSlashCommand("/gsd auto")
    const notice = getBrowserSlashCommandTerminalNotice(outcome)
    assert.equal(notice, null, "passthrough outcome should produce no terminal notice")
  })
})

test("every GSD surface dispatches through the contract wiring end-to-end", async (t) => {
  const gsdSurfaces = [...EXPECTED_GSD_OUTCOMES.entries()].filter(([, kind]) => kind === "surface")

  assert.equal(gsdSurfaces.length, 19, "should have exactly 19 GSD surface subcommands")

  for (const [subcommand] of gsdSurfaces) {
    await t.test(`/gsd ${subcommand} -> dispatch -> open request -> surface state`, () => {
      const outcome = dispatchBrowserSlashCommand(`/gsd ${subcommand}`)
      assert.equal(outcome.kind, "surface")

      const openRequest = surfaceOutcomeToOpenRequest(outcome, {})
      const state = openCommandSurfaceState(createInitialCommandSurfaceState(), openRequest)

      assert.equal(state.open, true, `surface state should be open for gsd-${subcommand}`)
      assert.ok(state.section, `surface state should have a non-null section for gsd-${subcommand}`)
      assert.equal(state.section, `gsd-${subcommand}`, `section should match gsd-${subcommand}`)
      assert.ok(state.selectedTarget, `surface state should have a non-null selectedTarget for gsd-${subcommand}`)
      assert.equal(state.selectedTarget.kind, "gsd", `target kind should be "gsd" for gsd-${subcommand}`)
      assert.equal(state.selectedTarget.subcommand, subcommand, `target subcommand should be "${subcommand}"`)
    })
  }
})

test("/gsd visualize dispatches as view-navigate to the visualizer view", () => {
  const outcome = dispatchBrowserSlashCommand("/gsd visualize")
  assert.equal(outcome.kind, "view-navigate")
  assert.equal(outcome.view, "visualize")
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

test("command-surface session affordances use the shared store action path", () => {
  const commandSurfacePath = resolve(import.meta.dirname, "../../../web/components/gsd/command-surface.tsx")
  const commandSurfaceSource = readFileSync(commandSurfacePath, "utf-8")

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
