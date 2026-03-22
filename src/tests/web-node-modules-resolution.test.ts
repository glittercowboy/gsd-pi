import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import { resolveSubprocessModule } from "../web/ts-subprocess-flags.ts"

// ---------------------------------------------------------------------------
// Reproduction test for #2081 — Web mode fails to start when installed
// under node_modules (global npm install) on Node v24+.
//
// Node v24 refuses to handle .ts files under node_modules/ regardless of
// --experimental-transform-types. The subprocess module resolver must
// prefer compiled .js in dist/ when the package lives under node_modules/.
// ---------------------------------------------------------------------------

test("resolveSubprocessModule returns .ts source path when not under node_modules", () => {
  const packageRoot = "/home/user/projects/gsd"
  const result = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/auto.ts", {
    existsSync: () => true,
  })
  assert.equal(result, join(packageRoot, "src", "resources", "extensions", "gsd", "auto.ts"))
})

test("resolveSubprocessModule returns compiled .js path when under node_modules and dist exists", () => {
  const packageRoot = "/usr/local/lib/node_modules/gsd-pi"
  const distPath = join(packageRoot, "dist", "resources", "extensions", "gsd", "auto.js")
  const result = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/auto.ts", {
    existsSync: (p: string) => p === distPath,
  })
  assert.equal(result, distPath)
})

test("resolveSubprocessModule falls back to .ts source when under node_modules but dist does not exist", () => {
  const packageRoot = "/usr/local/lib/node_modules/gsd-pi"
  const result = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/auto.ts", {
    existsSync: () => false,
  })
  assert.equal(result, join(packageRoot, "src", "resources", "extensions", "gsd", "auto.ts"))
})

test("resolveSubprocessModule handles Windows-style paths under node_modules", () => {
  const packageRoot = "C:\\Users\\dev\\AppData\\node_modules\\gsd-pi"
  const distPath = join(packageRoot, "dist", "resources", "extensions", "gsd", "auto.js")
  const result = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/auto.ts", {
    existsSync: (p: string) => p === distPath,
  })
  assert.equal(result, distPath)
})

test("resolveSubprocessModule strips .ts extension and adds .js for dist path", () => {
  const packageRoot = "/usr/lib/node_modules/gsd-pi"
  const distPath = join(packageRoot, "dist", "resources", "extensions", "gsd", "visualizer-data.js")
  const result = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/visualizer-data.ts", {
    existsSync: (p: string) => p === distPath,
  })
  assert.equal(result, distPath)
})
