import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { StringDecoder } from "node:string_decoder"

const repoRoot = process.cwd()
const bridge = await import("../../web/bridge-service.ts")
const recoveryRoute = await import("../../../web/app/api/recovery/route.ts")

class FakeRpcChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode === null) {
      this.exitCode = 0
    }
    queueMicrotask(() => {
      this.emit("exit", this.exitCode, signal)
    })
    return true
  }
}

function attachJsonLineReader(stream: PassThrough, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8")
  let buffer = ""

  stream.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
    while (true) {
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) return
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
    }
  })
}

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function createHarness(onCommand: (command: any, harness: ReturnType<typeof createHarness>) => void) {
  let child: FakeRpcChild | null = null

  const harness = {
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      child = new FakeRpcChild()
      attachJsonLineReader(child.stdin, (line) => {
        onCommand(JSON.parse(line), harness)
      })
      void command
      void args
      void options
      return child as any
    },
    emit(payload: unknown) {
      if (!child) throw new Error("fake child not started")
      child.stdout.write(serializeJsonLine(payload))
    },
  }

  return harness
}

function readyOnboardingState(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    locked: false,
    lockReason: null,
    required: {
      blocking: true,
      skippable: false,
      satisfied: true,
      satisfiedBy: { providerId: "anthropic", source: "auth_file" },
      providers: [],
    },
    optional: {
      blocking: false,
      skippable: true,
      sections: [],
    },
    lastValidation: null,
    activeFlow: null,
    bridgeAuthRefresh: {
      phase: "idle",
      strategy: null,
      startedAt: null,
      completedAt: null,
      error: null,
    },
    ...overrides,
  }
}

function makeRecoveryFixture(): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-recovery-contract-"))
  const projectCwd = join(root, "project")
  const sessionsDir = join(root, "sessions")
  const milestoneDir = join(projectCwd, ".gsd", "milestones", "M001")
  const sliceDir = join(milestoneDir, "slices", "S01")
  const tasksDir = join(sliceDir, "tasks")

  mkdirSync(tasksDir, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    "# M001: Recovery Demo\n\n## Slices\n- [ ] **S01: Recovery Slice** `risk:high` `depends:[]`\n  > After this: recovery route exists\n",
  )
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Recovery Slice",
      "",
      "**Goal:** Recovery diagnostics demo",
      "**Demo:** Recovery diagnostics load in browser",
      "",
      "## Must-Haves",
      "- Recovery diagnostics exist",
      "",
      "## Tasks",
      "- [x] **T01: Broken task for doctor coverage** `est:10m`",
      "  Intentionally missing a summary to surface doctor diagnostics.",
    ].join("\n"),
  )
  writeFileSync(
    join(tasksDir, "T01-PLAN.md"),
    [
      "# T01: Broken task for doctor coverage",
      "",
      "## Steps",
      "- leave this task incomplete on purpose",
    ].join("\n"),
  )

  return {
    projectCwd,
    sessionsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function makeEmptyProjectFixture(): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-recovery-empty-"))
  const projectCwd = join(root, "project")
  const sessionsDir = join(root, "sessions")
  mkdirSync(projectCwd, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
  return {
    projectCwd,
    sessionsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function createRecoverySessionFile(projectCwd: string, sessionsDir: string, sessionId: string): string {
  const sessionPath = join(sessionsDir, `2026-03-15T03-30-00-000Z_${sessionId}.jsonl`)
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-03-15T03:30:00.000Z", cwd: projectCwd }),
      JSON.stringify({ type: "session_info", id: `${sessionId}-info`, parentId: null, timestamp: "2026-03-15T03:30:01.000Z", name: "Recovery Session" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          isError: true,
          content: "authentication failed for sk-test-recovery-secret-9999",
        },
      }),
    ].join("\n") + "\n",
  )
  return sessionPath
}

function fakeSessionState(sessionId: string, sessionPath?: string) {
  return {
    sessionId,
    sessionFile: sessionPath,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: false,
    autoRetryEnabled: true,
    retryInProgress: true,
    retryAttempt: 2,
    messageCount: 3,
    pendingMessageCount: 0,
  }
}

test("/api/recovery returns structured recovery diagnostics and redacts secrets", async (t) => {
  const fixture = makeRecoveryFixture()
  const sessionPath = createRecoverySessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-recovery")
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-recovery", sessionPath),
      })
      return
    }
    assert.fail(`unexpected command: ${command.type}`)
  })

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: harness.spawn,
    getOnboardingState: async () => readyOnboardingState({
      locked: true,
      lockReason: "bridge_refresh_failed",
      bridgeAuthRefresh: {
        phase: "failed",
        strategy: "restart",
        startedAt: "2026-03-15T03:31:00.000Z",
        completedAt: "2026-03-15T03:31:05.000Z",
        error: "Bridge refresh failed for sk-onboarding-secret-1234",
      },
    }),
  })

  t.after(async () => {
    await bridge.resetBridgeServiceForTests()
    fixture.cleanup()
  });

  const response = await recoveryRoute.GET()
  assert.equal(response.status, 200)
  const payload = await response.json() as any

  assert.equal(payload.status, "ready")
  assert.equal(payload.project.activeSessionPath, sessionPath)
  assert.equal(payload.project.activeSessionId, "sess-recovery")
  assert.equal(payload.bridge.retry.inProgress, true)
  assert.equal(payload.bridge.retry.attempt, 2)
  assert.equal(payload.bridge.authRefresh.phase, "failed")
  assert.match(payload.bridge.authRefresh.label, /failed/i)
  assert.ok(typeof payload.doctor.total === "number")
  assert.ok(Array.isArray(payload.doctor.codes))
  assert.ok(typeof payload.validation.total === "number")
  assert.equal(payload.interruptedRun.detected, true)
  assert.match(payload.interruptedRun.lastError ?? "", /\[redacted\]/)
  assert.deepEqual(
    payload.actions.browser.map((action: { id: string }) => action.id),
    ["refresh_diagnostics", "refresh_workspace", "open_retry_controls", "open_resume_controls", "open_auth_controls"],
  )
  assert.ok(payload.actions.commands.some((entry: { command: string }) => entry.command.includes("/gsd doctor")))

  const serialized = JSON.stringify(payload)
  assert.doesNotMatch(serialized, /sk-test-recovery-secret-9999|sk-onboarding-secret-1234/)
  assert.doesNotMatch(serialized, /Crash Recovery Briefing|Completed Tool Calls|toolCallId/)
})

test("/api/recovery prefers the current-project resumable session when the live bridge session is out of scope", async (t) => {
  const fixture = makeRecoveryFixture()
  const sessionPath = createRecoverySessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-recovery")
  const externalSessionPath = join(fixture.projectCwd, "..", "agent-sessions", "2026-03-15T03-40-00-000Z_sess-external.jsonl")
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-external", externalSessionPath),
      })
      return
    }
    assert.fail(`unexpected command: ${command.type}`)
  })

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: harness.spawn,
    getOnboardingState: async () => readyOnboardingState(),
  })

  t.after(async () => {
    await bridge.resetBridgeServiceForTests()
    fixture.cleanup()
  });

  const response = await recoveryRoute.GET()
  assert.equal(response.status, 200)
  const payload = await response.json() as any

  assert.equal(payload.project.activeSessionPath, sessionPath)
  assert.equal(payload.project.activeSessionId, "sess-recovery")
  assert.equal(payload.interruptedRun.detected, true)
  assert.match(payload.interruptedRun.lastError ?? "", /\[redacted\]/)
  assert.deepEqual(
    payload.actions.browser.map((action: { id: string }) => action.id),
    ["refresh_diagnostics", "refresh_workspace", "open_retry_controls", "open_resume_controls"],
  )
})

test("/api/recovery returns a structured empty-project payload without leaking raw diagnostics", async (t) => {
  const fixture = makeEmptyProjectFixture()
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          ...fakeSessionState("sess-empty"),
          autoRetryEnabled: false,
          retryInProgress: false,
          retryAttempt: 0,
        },
      })
      return
    }
    assert.fail(`unexpected command: ${command.type}`)
  })

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: harness.spawn,
    getOnboardingState: async () => readyOnboardingState(),
  })

  t.after(async () => {
    await bridge.resetBridgeServiceForTests()
    fixture.cleanup()
  });

  const response = await recoveryRoute.GET()
  assert.equal(response.status, 200)
  const payload = await response.json() as any

  assert.ok(["ready", "unavailable"].includes(payload.status))
  assert.equal(payload.project.activeScope, null)
  assert.equal(payload.validation.total, 0)
  assert.ok(typeof payload.doctor.total === "number")
  assert.ok(typeof payload.interruptedRun.available === "boolean")
  assert.deepEqual(
    payload.actions.browser.map((action: { id: string }) => action.id),
    ["refresh_diagnostics", "refresh_workspace"],
  )
})
