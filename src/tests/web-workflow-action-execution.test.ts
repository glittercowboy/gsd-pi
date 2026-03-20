import test from "node:test"
import assert from "node:assert/strict"

const {
  derivePendingWorkflowCommandLabel,
  executeWorkflowActionInPowerMode,
  navigateToGSDView,
} = await import("../../web/lib/workflow-action-execution.ts")

test("derivePendingWorkflowCommandLabel prefers the latest input line while a command is in flight", () => {
  const label = derivePendingWorkflowCommandLabel({
    commandInFlight: "prompt",
    terminalLines: [
      { id: "1", timestamp: "12:00", type: "system", content: "Bridge ready" },
      { id: "2", timestamp: "12:01", type: "input", content: "/gsd" },
      { id: "3", timestamp: "12:02", type: "system", content: "Working…" },
    ],
  })

  assert.equal(label, "/gsd")
})

test("derivePendingWorkflowCommandLabel falls back to the command type when no input line exists", () => {
  const label = derivePendingWorkflowCommandLabel({
    commandInFlight: "abort",
    terminalLines: [],
  })

  assert.equal(label, "/abort")
})

test("navigateToGSDView dispatches the shared browser navigation event", () => {
  const originalWindow = (globalThis as { window?: EventTarget }).window
  const fakeWindow = new EventTarget()
  const seen: string[] = []

  fakeWindow.addEventListener("gsd:navigate-view", (event: Event) => {
    seen.push((event as CustomEvent<{ view: string }>).detail.view)
  })

  ;(globalThis as { window?: EventTarget }).window = fakeWindow

  try {
    navigateToGSDView("power")
  } finally {
    ;(globalThis as { window?: EventTarget }).window = originalWindow
  }

  assert.deepEqual(seen, ["power"])
})

test("executeWorkflowActionInPowerMode sends the workflow command and navigates to power mode", async () => {
  const originalWindow = (globalThis as { window?: EventTarget }).window
  const fakeWindow = new EventTarget()
  const seenViews: string[] = []
  const sentCommands: Array<{ type: string; message?: string }> = []

  fakeWindow.addEventListener("gsd:navigate-view", (event: Event) => {
    seenViews.push((event as CustomEvent<{ view: string }>).detail.view)
  })

  ;(globalThis as { window?: EventTarget }).window = fakeWindow

  try {
    await executeWorkflowActionInPowerMode({
      command: "/gsd",
      bridge: null,
      sendCommand: async (command) => {
        sentCommands.push(command)
        return { ok: true }
      },
    })
  } finally {
    ;(globalThis as { window?: EventTarget }).window = originalWindow
  }

  assert.deepEqual(seenViews, ["power"])
  assert.equal(sentCommands.length, 1)
  assert.equal(sentCommands[0]?.type, "prompt")
  assert.equal(sentCommands[0]?.message, "/gsd")
})
