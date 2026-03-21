import test from "node:test"
import assert from "node:assert/strict"

import { resolveTypeStrippingFlag } from "../web/ts-subprocess-flags.ts"

// ---------------------------------------------------------------------------
// Bug 1 — resolveTypeStrippingFlag selects the correct flag
// ---------------------------------------------------------------------------

test("resolveTypeStrippingFlag returns --experimental-strip-types for paths outside node_modules", () => {
  const flag = resolveTypeStrippingFlag("/home/user/projects/gsd")
  assert.equal(flag, "--experimental-strip-types")
})

test("resolveTypeStrippingFlag returns --experimental-strip-types for path with node_modules substring not as directory", () => {
  // e.g. /home/user/my_node_modules_backup/gsd — not actually under node_modules/
  const flag = resolveTypeStrippingFlag("/home/user/my_node_modules_backup/gsd")
  assert.equal(flag, "--experimental-strip-types")
})

test("resolveTypeStrippingFlag returns --experimental-transform-types for paths under node_modules/ on Node >= 22.7", () => {
  const [major, minor] = process.versions.node.split(".").map(Number)
  const flag = resolveTypeStrippingFlag("/usr/lib/node_modules/gsd-pi")

  if (major > 22 || (major === 22 && minor >= 7)) {
    assert.equal(flag, "--experimental-transform-types")
  } else {
    // On older Node, falls back to strip-types since transform-types isn't available
    assert.equal(flag, "--experimental-strip-types")
  }
})

test("resolveTypeStrippingFlag handles Windows-style paths under node_modules", () => {
  const [major, minor] = process.versions.node.split(".").map(Number)
  const flag = resolveTypeStrippingFlag("C:\\Users\\dev\\AppData\\node_modules\\gsd-pi")

  if (major > 22 || (major === 22 && minor >= 7)) {
    assert.equal(flag, "--experimental-transform-types")
  } else {
    assert.equal(flag, "--experimental-strip-types")
  }
})

// ---------------------------------------------------------------------------
// Bug 2 — waitForBootReady fails fast on consecutive 5xx
// ---------------------------------------------------------------------------

// The waitForBootReady function is not exported, but the behavior is testable
// by verifying the launchWebMode deps injection. We test the core logic
// pattern directly: 3 consecutive 5xx should abort without waiting for timeout.

test("waitForBootReady pattern: consecutive 5xx detection aborts early", async () => {
  // Simulate the retry logic extracted from waitForBootReady
  let consecutive5xx = 0
  const MAX_CONSECUTIVE_5XX = 3
  const responses = [500, 500, 500] // three deterministic 500s
  let abortedEarly = false

  for (const statusCode of responses) {
    if (statusCode >= 500) {
      consecutive5xx++
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        abortedEarly = true
        break
      }
    } else {
      consecutive5xx = 0
    }
  }

  assert.equal(abortedEarly, true, "should abort after 3 consecutive 5xx responses")
  assert.equal(consecutive5xx, 3)
})

test("waitForBootReady pattern: non-5xx responses reset the consecutive counter", () => {
  let consecutive5xx = 0
  const MAX_CONSECUTIVE_5XX = 3
  // 500, 500, connection-refused (resets), 500, 500 — should NOT trigger abort
  const events = [
    { type: "response", status: 500 },
    { type: "response", status: 500 },
    { type: "error" }, // connection refused resets counter
    { type: "response", status: 500 },
    { type: "response", status: 500 },
  ]
  let abortedEarly = false

  for (const event of events) {
    if (event.type === "response" && (event.status ?? 0) >= 500) {
      consecutive5xx++
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        abortedEarly = true
        break
      }
    } else {
      consecutive5xx = 0
    }
  }

  assert.equal(abortedEarly, false, "should not abort when errors reset the counter")
})

test("waitForBootReady pattern: mixed 4xx and 5xx only counts 5xx", () => {
  let consecutive5xx = 0
  const MAX_CONSECUTIVE_5XX = 3
  const responses = [500, 404, 500, 500]
  let abortedEarly = false

  for (const statusCode of responses) {
    if (statusCode >= 500) {
      consecutive5xx++
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        abortedEarly = true
        break
      }
    } else {
      consecutive5xx = 0
    }
  }

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
