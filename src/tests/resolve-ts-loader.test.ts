import test from "node:test"
import assert from "node:assert/strict"

import { load as loadWithTestLoader, resolve as resolveWithTestLoader } from "../resources/extensions/gsd/tests/dist-redirect.mjs"

const nextResolve = async (specifier: string) => ({ url: specifier })

const cases = [
  ["@gsd/pi-coding-agent", "../../packages/pi-coding-agent/src/index.ts"],
] as const

test("resolve-ts loader redirects pi-coding-agent bare imports to the workspace source entrypoint", async () => {
  for (const [specifier, relativeTarget] of cases) {
    const resolved = await resolveWithTestLoader(specifier, {}, nextResolve)
    assert.equal(
      resolved.url,
      new URL(relativeTarget, import.meta.url).href,
      `${specifier} should resolve to ${relativeTarget}`,
    )
  }
})

test("resolve-ts loader rewrites direct pi-coding-agent source entry import to .ts", async () => {
  const resolved = await resolveWithTestLoader(
    "../../packages/pi-coding-agent/src/index.js",
    {},
    nextResolve,
  )

  assert.equal(
    resolved.url,
    new URL("../../packages/pi-coding-agent/src/index.ts", import.meta.url).href,
  )
})

test("resolve-ts loader transpiles pi-coding-agent source files that strip-only mode cannot parse", async () => {
  const orchestratorUrl = new URL(
    "../../packages/pi-coding-agent/src/core/compaction-orchestrator.ts",
    import.meta.url,
  ).href

  const loaded = await loadWithTestLoader(orchestratorUrl, {}, async () => {
    throw new Error("expected pi-coding-agent source to be transpiled before nextLoad")
  })

  assert.equal(loaded.format, "module")
  assert.equal(loaded.shortCircuit, true)
  assert.match(loaded.source, /constructor\(_deps\)/, "transpiled constructor should be valid JavaScript")
  assert.doesNotMatch(loaded.source, /private readonly _deps/, "TypeScript parameter property syntax should be removed")
})
