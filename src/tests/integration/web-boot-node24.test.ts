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
  // Read the route source to verify try/catch wrapping is present
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")

  const routeSource = readFileSync(
    join(process.cwd(), "web", "app", "api", "boot", "route.ts"),
    "utf-8",
  )

  // The route must catch errors and return { error: message }
  assert.match(routeSource, /try\s*\{/, "boot route must have try block")
  assert.match(routeSource, /catch\s*\(/, "boot route must have catch block")
  assert.match(
    routeSource,
    /\{\s*error:\s*message\s*\}/,
    "boot route must return { error: message } on failure",
  )
  assert.match(
    routeSource,
    /status:\s*500/,
    "boot route must return status 500 on error",
  )
})

// ---------------------------------------------------------------------------
// Bug 4 — bridge-service must import readdirSync for session listing (#1936)
// ---------------------------------------------------------------------------

test("bridge-service imports readdirSync from node:fs (#1936)", async () => {
  // The boot payload calls listProjectSessions which uses readdirSync.
  // A missing import causes ReferenceError → HTTP 500 on /api/boot.
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")

  const bridgeSource = readFileSync(
    join(process.cwd(), "src", "web", "bridge-service.ts"),
    "utf-8",
  )

  assert.match(
    bridgeSource,
    /import\s*\{[^}]*readdirSync[^}]*\}\s*from\s*["']node:fs["']/,
    "bridge-service.ts must import readdirSync from node:fs — " +
      "removing it breaks /api/boot with ReferenceError (see #1936)",
  )
})
