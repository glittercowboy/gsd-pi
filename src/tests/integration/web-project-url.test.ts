import test from "node:test"
import assert from "node:assert/strict"

import { buildProjectAbsoluteUrl, buildProjectPath } from "../../web/lib/project-url.ts"

test("buildProjectPath leaves non-project routes unchanged", () => {
  assert.equal(buildProjectPath("/api/terminal/input"), "/api/terminal/input")
})

test("buildProjectPath appends project while preserving existing query params", () => {
  const path = buildProjectPath("/api/bridge-terminal/stream?cols=132&rows=41", "/tmp/Project With Spaces")
  const url = new URL(path, "http://localhost")

  assert.equal(url.pathname, "/api/bridge-terminal/stream")
  assert.equal(url.searchParams.get("cols"), "132")
  assert.equal(url.searchParams.get("rows"), "41")
  assert.equal(url.searchParams.get("project"), "/tmp/Project With Spaces")
})

test("buildProjectAbsoluteUrl produces a same-origin URL with the active project scope", () => {
  const url = buildProjectAbsoluteUrl(
    "/api/terminal/stream?id=gsd-interactive&command=gsd",
    "http://localhost:3000",
    "/Users/sn0w/Documents/dev/Other Project",
  )

  assert.equal(url.origin, "http://localhost:3000")
  assert.equal(url.pathname, "/api/terminal/stream")
  assert.equal(url.searchParams.get("id"), "gsd-interactive")
  assert.equal(url.searchParams.get("command"), "gsd")
  assert.equal(url.searchParams.get("project"), "/Users/sn0w/Documents/dev/Other Project")
})
