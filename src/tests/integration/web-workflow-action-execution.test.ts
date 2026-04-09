import test from "node:test"
import assert from "node:assert/strict"

const {
  derivePendingWorkflowCommandLabel,
  executeWorkflowActionInPowerMode,
  navigateToGSDView,
} = await import("../../../web/lib/workflow-action-execution.ts")

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

test("navigateToGSDView dispatches the shared browser navigation event", (t) => {
  const originalWindow = (globalThis as { window?: EventTarget }).window
  const fakeWindow = new EventTarget()
  const seen: string[] = []

  fakeWindow.addEventListener("gsd:navigate-view", (event: Event) => {
    seen.push((event as CustomEvent<{ view: string }>).detail.view)
  })

  ;(globalThis as { window?: EventTarget }).window = fakeWindow

  t.after(() => { ;(globalThis as { window?: EventTarget }).window = originalWindow });

  navigateToGSDView("power")

  assert.deepEqual(seen, ["power"])
})

test("executeWorkflowActionInPowerMode calls dispatch and navigates to the appropriate view", async (t) => {
  const originalWindow = (globalThis as { window?: EventTarget }).window
  const originalLocalStorage = (globalThis as any).localStorage
  const fakeWindow = new EventTarget()
  const seenViews: string[] = []
  let dispatchCalled = false

  fakeWindow.addEventListener("gsd:navigate-view", (event: Event) => {
    seenViews.push((event as CustomEvent<{ view: string }>).detail.view)
  })

  ;(globalThis as { window?: EventTarget }).window = fakeWindow
  ;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} }

  t.after(() => {
    ;(globalThis as { window?: EventTarget }).window = originalWindow
    ;(globalThis as any).localStorage = originalLocalStorage
  });

  executeWorkflowActionInPowerMode({
    dispatch: async () => {
      dispatchCalled = true
    },
  })
  // dispatch is fire-and-forget, give it a tick to resolve
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(dispatchCalled, true, "dispatch should have been called")
  assert.ok(seenViews.length > 0, "should navigate to a view")
})
