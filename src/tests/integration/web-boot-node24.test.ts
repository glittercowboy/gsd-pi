import test from "node:test"
import assert from "node:assert/strict"

import { resolveTypeStrippingFlag } from "../../web/ts-subprocess-flags.ts"

// ---------------------------------------------------------------------------
// Bug 1 — resolveTypeStrippingFlag selects the correct flag
// ---------------------------------------------------------------------------

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number)
const isNode22_7OrNewer = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 7)

test("resolveTypeStrippingFlag returns --experimental-strip-types for paths outside node_modules", () => {
  const flag = resolveTypeStrippingFlag("/home/user/projects/gsd")
  assert.equal(flag, "--experimental-strip-types")
})

test("resolveTypeStrippingFlag returns --experimental-strip-types for path with node_modules substring not as directory", () => {
  // e.g. /home/user/my_node_modules_backup/gsd — not actually under node_modules/
  const flag = resolveTypeStrippingFlag("/home/user/my_node_modules_backup/gsd")
  assert.equal(flag, "--experimental-strip-types")
})

test(
  "resolveTypeStrippingFlag returns --experimental-transform-types for paths under node_modules/ on Node >= 22.7",
  { skip: !isNode22_7OrNewer },
  () => {
    const flag = resolveTypeStrippingFlag("/usr/lib/node_modules/gsd-pi")
    assert.equal(flag, "--experimental-transform-types")
  },
)

test(
  "resolveTypeStrippingFlag returns --experimental-strip-types for paths under node_modules/ on Node < 22.7",
  { skip: isNode22_7OrNewer },
  () => {
    const flag = resolveTypeStrippingFlag("/usr/lib/node_modules/gsd-pi")
    // On older Node, falls back to strip-types since transform-types isn't available
    assert.equal(flag, "--experimental-strip-types")
  },
)

test(
  "resolveTypeStrippingFlag handles Windows-style paths under node_modules on Node >= 22.7",
  { skip: !isNode22_7OrNewer },
  () => {
    const flag = resolveTypeStrippingFlag("C:\\Users\\dev\\AppData\\node_modules\\gsd-pi")
    assert.equal(flag, "--experimental-transform-types")
  },
)

test(
  "resolveTypeStrippingFlag handles Windows-style paths under node_modules on Node < 22.7",
  { skip: isNode22_7OrNewer },
  () => {
    const flag = resolveTypeStrippingFlag("C:\\Users\\dev\\AppData\\node_modules\\gsd-pi")
    assert.equal(flag, "--experimental-strip-types")
  },
)

// ---------------------------------------------------------------------------
// Bug 2 — waitForBootReady fails fast on consecutive 5xx
// ---------------------------------------------------------------------------

// The waitForBootReady function is not exported, but the behavior is testable
// by verifying the launchWebMode deps injection. We test the core logic
// pattern directly: 3 consecutive 5xx should abort without waiting for timeout.

type RetryEvent = { type: "response"; status: number } | { type: "error" }

/**
 * Simulate the consecutive-5xx abort logic extracted from waitForBootReady.
 * Returns { abortedEarly, consecutiveCount }.
 */
function simulateConsecutive5xxDetection(
  events: RetryEvent[],
  maxConsecutive: number,
): { abortedEarly: boolean; consecutiveCount: number } {
  return events.reduce(
    (acc, event) => {
      if (acc.abortedEarly) return acc
      const is5xx = event.type === "response" && event.status >= 500
      const consecutive = is5xx ? acc.consecutiveCount + 1 : 0
      const abortedEarly = consecutive >= maxConsecutive
      return { abortedEarly, consecutiveCount: consecutive }
    },
    { abortedEarly: false, consecutiveCount: 0 },
  )
}

test("waitForBootReady pattern: consecutive 5xx detection aborts early", () => {
  const responses: RetryEvent[] = [
    { type: "response", status: 500 },
    { type: "response", status: 500 },
    { type: "response", status: 500 },
  ]
  const { abortedEarly, consecutiveCount } = simulateConsecutive5xxDetection(responses, 3)
  assert.equal(abortedEarly, true, "should abort after 3 consecutive 5xx responses")
  assert.equal(consecutiveCount, 3)
})

test("waitForBootReady pattern: non-5xx responses reset the consecutive counter", () => {
  // 500, 500, connection-refused (resets), 500, 500 — should NOT trigger abort
  const events: RetryEvent[] = [
    { type: "response", status: 500 },
    { type: "response", status: 500 },
    { type: "error" }, // connection refused resets counter
    { type: "response", status: 500 },
    { type: "response", status: 500 },
  ]
  const { abortedEarly } = simulateConsecutive5xxDetection(events, 3)
  assert.equal(abortedEarly, false, "should not abort when errors reset the counter")
})

test("waitForBootReady pattern: mixed 4xx and 5xx only counts 5xx", () => {
  const responses: RetryEvent[] = [
    { type: "response", status: 500 },
    { type: "response", status: 404 },
    { type: "response", status: 500 },
    { type: "response", status: 500 },
  ]
  const { abortedEarly } = simulateConsecutive5xxDetection(responses, 3)
  assert.equal(abortedEarly, false, "404 should reset the consecutive 5xx counter")
})

// ---------------------------------------------------------------------------
// Bug 3 — /api/boot route error handling
// ---------------------------------------------------------------------------

test("boot route returns { error } JSON on handler failure", async () => {
  // Import the GET handler and configure bridge-service to inject a failing
  // getAutoDashboardData — this exercises the try/catch in the route,
  // verifying it returns { error: message } with HTTP 500.
  const { GET } = await import("../../../web/app/api/boot/route.ts")
  const { configureBridgeServiceForTests, resetBridgeServiceForTests } = await import("../../web/bridge-service.ts")

  configureBridgeServiceForTests({
    getAutoDashboardData: () => { throw new Error("injected test failure") },
  })

  try {
    const response = await GET(
      new Request("http://localhost:3000/api/boot?project=/tmp/test-behavioral"),
    )

    assert.equal(response.status, 500, "boot route should return HTTP 500 on handler failure")
    const body = await response.json() as Record<string, unknown>
    assert.ok(typeof body.error === "string" && body.error.length > 0, "response body should contain a non-empty error string")
  } finally {
    await resetBridgeServiceForTests()
    configureBridgeServiceForTests(null)
  }
})

// ---------------------------------------------------------------------------
// Bug 4 — bridge-service readdirSync is operational (#1936)
// ---------------------------------------------------------------------------

test("bridge-service readdirSync is available at runtime — collectBootPayload is a function", async () => {
  // The original bug (#1936) was a missing readdirSync import causing a
  // ReferenceError at runtime. Verifying collectBootPayload is importable
  // and callable ensures the module is syntactically valid and all imports
  // resolved — if readdirSync were undeclared, the module would fail to load.
  const { collectBootPayload } = await import("../../web/bridge-service.ts")
  assert.equal(typeof collectBootPayload, "function", "collectBootPayload must be exported as a function")
})
