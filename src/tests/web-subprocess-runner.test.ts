import test from "node:test"
import assert from "node:assert/strict"

const { runSubprocess, resolveModulePaths } = await import("../web/subprocess-runner.ts")

// ---------------------------------------------------------------------------
// resolveModulePaths — centralised TS loader + module path resolution
// ---------------------------------------------------------------------------

test("resolveModulePaths returns tsLoaderPath and validates it exists", () => {
  const packageRoot = "/fake/package"
  const result = resolveModulePaths(packageRoot, {
    modules: [{ envKey: "MOD", relativePath: "src/mod.ts" }],
    existsSync: () => true,
  })
  assert.equal(
    result.tsLoaderPath,
    "/fake/package/src/resources/extensions/gsd/tests/resolve-ts.mjs",
  )
})

test("resolveModulePaths throws when TS loader is missing", () => {
  const packageRoot = "/fake/package"
  assert.throws(
    () =>
      resolveModulePaths(packageRoot, {
        modules: [{ envKey: "MOD", relativePath: "src/mod.ts" }],
        existsSync: () => false,
        label: "test-service",
      }),
    (error: Error) => {
      assert.match(error.message, /test-service/)
      assert.match(error.message, /not found/)
      return true
    },
  )
})

test("resolveModulePaths throws when any module path is missing", () => {
  const packageRoot = "/fake/package"
  const existingSets = new Set([
    "/fake/package/src/resources/extensions/gsd/tests/resolve-ts.mjs",
  ])
  assert.throws(
    () =>
      resolveModulePaths(packageRoot, {
        modules: [
          { envKey: "MOD_A", relativePath: "src/a.ts" },
          { envKey: "MOD_B", relativePath: "src/b.ts" },
        ],
        existsSync: (p: string) => existingSets.has(p),
        label: "multi-mod",
      }),
    (error: Error) => {
      assert.match(error.message, /multi-mod/)
      return true
    },
  )
})

test("resolveModulePaths returns env entries for each module", () => {
  const packageRoot = "/fake/package"
  const result = resolveModulePaths(packageRoot, {
    modules: [
      { envKey: "GSD_MOD_A", relativePath: "src/a.ts" },
      { envKey: "GSD_MOD_B", relativePath: "src/b.ts" },
    ],
    existsSync: () => true,
  })
  assert.deepEqual(result.env, {
    GSD_MOD_A: "/fake/package/src/a.ts",
    GSD_MOD_B: "/fake/package/src/b.ts",
  })
})

// ---------------------------------------------------------------------------
// runSubprocess — shared execFile + JSON.parse wrapper
// ---------------------------------------------------------------------------

test("runSubprocess returns parsed JSON from a child process", async () => {
  const result = await runSubprocess<{ hello: string }>({
    packageRoot: process.cwd(),
    script: 'process.stdout.write(JSON.stringify({ hello: "world" }));',
    env: {},
    label: "test",
  })
  assert.deepEqual(result, { hello: "world" })
})

test("runSubprocess rejects when child process exits with error", async () => {
  await assert.rejects(
    () =>
      runSubprocess({
        packageRoot: process.cwd(),
        script: 'process.exit(1);',
        env: {},
        label: "exit-test",
      }),
    (error: Error) => {
      assert.match(error.message, /exit-test/)
      assert.match(error.message, /subprocess failed/)
      return true
    },
  )
})

test("runSubprocess rejects on invalid JSON output", async () => {
  await assert.rejects(
    () =>
      runSubprocess({
        packageRoot: process.cwd(),
        script: 'process.stdout.write("not json");',
        env: {},
        label: "json-test",
      }),
    (error: Error) => {
      assert.match(error.message, /json-test/)
      assert.match(error.message, /invalid JSON/)
      return true
    },
  )
})

test("runSubprocess applies timeout option", async () => {
  await assert.rejects(
    () =>
      runSubprocess({
        packageRoot: process.cwd(),
        script: 'setTimeout(() => {}, 60000);',
        env: {},
        label: "timeout-test",
        timeoutMs: 500,
      }),
    (error: Error) => {
      assert.match(error.message, /timeout-test/)
      return true
    },
  )
})

test("runSubprocess accepts custom maxBuffer", async () => {
  // Verify it does not throw with a reasonable buffer
  const result = await runSubprocess<{ ok: boolean }>({
    packageRoot: process.cwd(),
    script: 'process.stdout.write(JSON.stringify({ ok: true }));',
    env: {},
    label: "buffer-test",
    maxBuffer: 512,
  })
  assert.equal(result.ok, true)
})

test("runSubprocess passes env vars to child process", async () => {
  const result = await runSubprocess<{ val: string }>({
    packageRoot: process.cwd(),
    script: 'process.stdout.write(JSON.stringify({ val: process.env.TEST_VAR }));',
    env: { TEST_VAR: "hello_from_parent" },
    label: "env-test",
  })
  assert.equal(result.val, "hello_from_parent")
})

test("runSubprocess includes stderr in error message on failure", async () => {
  await assert.rejects(
    () =>
      runSubprocess({
        packageRoot: process.cwd(),
        script: 'process.stderr.write("detailed error info"); process.exit(1);',
        env: {},
        label: "stderr-test",
      }),
    (error: Error) => {
      assert.match(error.message, /detailed error info/)
      return true
    },
  )
})
