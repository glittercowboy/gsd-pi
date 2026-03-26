import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import {
  isUnderNodeModules,
  resolveSubprocessModule,
} from "../web/ts-subprocess-flags.ts"

// ---------------------------------------------------------------------------
// isUnderNodeModules — exported utility
// ---------------------------------------------------------------------------

test("isUnderNodeModules returns false for paths outside node_modules", () => {
  assert.equal(isUnderNodeModules("/home/user/projects/gsd"), false)
})

test("isUnderNodeModules returns true for Unix paths under node_modules/", () => {
  assert.equal(
    isUnderNodeModules("/usr/lib/node_modules/gsd-pi"),
    true,
  )
})

test("isUnderNodeModules returns true for Windows paths under node_modules/", () => {
  assert.equal(
    isUnderNodeModules("C:\\Users\\dev\\AppData\\node_modules\\gsd-pi"),
    true,
  )
})

test("isUnderNodeModules returns false for substring match without trailing slash", () => {
  assert.equal(
    isUnderNodeModules("/home/user/my_node_modules_backup/gsd"),
    false,
  )
})

// ---------------------------------------------------------------------------
// resolveSubprocessModule — resolves .ts → dist .js under node_modules
// ---------------------------------------------------------------------------

test("resolveSubprocessModule returns source .ts path when NOT under node_modules", () => {
  const packageRoot = "/home/user/projects/gsd"
  const result = resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/workspace-index.ts",
    // existsSync not needed — should return src path without checking dist
  )

  assert.deepEqual(result, {
    modulePath: join(packageRoot, "src", "resources/extensions/gsd/workspace-index.ts"),
    useCompiledJs: false,
  })
})

test("resolveSubprocessModule returns compiled .js path when under node_modules and dist file exists", () => {
  const packageRoot = "/usr/lib/node_modules/gsd-pi"
  const distPath = join(packageRoot, "dist", "resources/extensions/gsd/workspace-index.js")
  const result = resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/workspace-index.ts",
    (p: string) => p === distPath,
  )

  assert.deepEqual(result, {
    modulePath: distPath,
    useCompiledJs: true,
  })
})

test("resolveSubprocessModule falls back to source .ts when under node_modules but dist file missing", () => {
  const packageRoot = "/usr/lib/node_modules/gsd-pi"
  const result = resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/workspace-index.ts",
    () => false, // dist file does not exist
  )

  assert.deepEqual(result, {
    modulePath: join(packageRoot, "src", "resources/extensions/gsd/workspace-index.ts"),
    useCompiledJs: false,
  })
})

test("resolveSubprocessModule handles Windows paths under node_modules", () => {
  const packageRoot = "C:\\Users\\dev\\AppData\\node_modules\\gsd-pi"
  const distPath = join(packageRoot, "dist", "resources/extensions/gsd/auto.js")
  const result = resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/auto.ts",
    (p: string) => p === distPath,
  )

  assert.deepEqual(result, {
    modulePath: distPath,
    useCompiledJs: true,
  })
})

test("resolveSubprocessModule strips .ts extension when building dist .js path", () => {
  const packageRoot = "/usr/lib/node_modules/gsd-pi"
  let checkedPath = ""
  resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/doctor.ts",
    (p: string) => { checkedPath = p; return true },
  )

  assert.equal(
    checkedPath,
    join(packageRoot, "dist", "resources/extensions/gsd/doctor.js"),
    "should check for .js file in dist/, not .ts",
  )
})

// ---------------------------------------------------------------------------
// Integration: bridge-service subprocess resolution pattern
// ---------------------------------------------------------------------------

test("bridge-service workspace-index subprocess uses compiled JS when under node_modules (source audit)", async () => {
  // Verify bridge-service.ts calls resolveSubprocessModule for workspace-index
  const { readFileSync } = await import("node:fs")
  const bridgeSource = readFileSync(
    join(process.cwd(), "src", "web", "bridge-service.ts"),
    "utf-8",
  )

  assert.match(
    bridgeSource,
    /resolveSubprocessModule/,
    "bridge-service.ts must use resolveSubprocessModule to resolve workspace-index path — " +
      "hardcoded .ts paths fail with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on Node v24 (see #2279)",
  )
})

test("all web service files use resolveSubprocessModule instead of hardcoded .ts paths (source audit)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")

  const serviceFiles = readdirSync(join(process.cwd(), "src", "web"))
    .filter((f: string) => f.endsWith("-service.ts"))

  for (const file of serviceFiles) {
    const source = readFileSync(join(process.cwd(), "src", "web", file), "utf-8")

    // If the service file imports resolveTypeStrippingFlag it spawns subprocesses
    // and must also use resolveSubprocessModule
    if (source.includes("resolveTypeStrippingFlag")) {
      assert.match(
        source,
        /resolveSubprocessModule/,
        `${file} uses resolveTypeStrippingFlag but does not use resolveSubprocessModule — ` +
          "subprocess .ts paths will fail under node_modules/ on Node v24 (#2279)",
      )
    }
  }
})
