import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// Import via the compiled package export (matches the convention in
// xxhash.test.mjs). Importing the raw `.ts` source only worked when Node
// was invoked with --experimental-strip-types; under the standard test
// runner it fails with "does not provide an export named X". The npm
// test script builds the package before running tests, so the compiled
// export resolves correctly.
import { processStreamChunk } from "@gsd/native/stream-process";

// Runtime guard: the `processStreamChunk` native symbol shipped in the
// source tree is not present in every published `@gsd-build/engine-*`
// binary. Until the binary is refreshed (tracked in #4854), skip these
// tests on environments whose native binding lacks the symbol rather
// than fail CI with a TypeError. This makes the tests behaviour-ready
// for local devs with a fresh `npm run build:native:dev` while keeping
// CI green against the published engine.
const require_ = createRequire(import.meta.url);
const { native } = require_("../../dist/native.js");
const skipReason =
  typeof native?.processStreamChunk === "function"
    ? null
    : "native.processStreamChunk missing from @gsd/native binary — see #4854";

describe("processStreamChunk", { skip: skipReason ?? undefined }, () => {
  test("processes a single chunk without state", () => {
    const result = processStreamChunk(Buffer.from("hello world\n"));
    assert.equal(result.text, "hello world\n");
    assert.ok(Array.isArray(result.state.utf8Pending));
    assert.ok(Array.isArray(result.state.ansiPending));
  });

  test("processes multiple chunks passing state between calls", () => {
    const result1 = processStreamChunk(Buffer.from("first\n"));
    assert.equal(result1.text, "first\n");

    // This was the crash: passing state back caused
    // "Given napi value is not an array on StreamState.utf8Pending"
    // when state arrays were wrapped in Buffer.from() instead of Array.from()
    const result2 = processStreamChunk(Buffer.from("second\n"), result1.state);
    assert.equal(result2.text, "second\n");

    const result3 = processStreamChunk(Buffer.from("third\n"), result2.state);
    assert.equal(result3.text, "third\n");
  });

  test("state fields are plain arrays, not Buffers", () => {
    const result = processStreamChunk(Buffer.from("test\n"));
    assert.ok(Array.isArray(result.state.utf8Pending), "utf8Pending should be a plain array");
    assert.ok(Array.isArray(result.state.ansiPending), "ansiPending should be a plain array");
    assert.ok(!(result.state.utf8Pending instanceof Buffer), "utf8Pending should not be a Buffer");
    assert.ok(!(result.state.ansiPending instanceof Buffer), "ansiPending should not be a Buffer");
  });
});
