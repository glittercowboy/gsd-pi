import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { processStreamChunk } from "../stream-process/index.ts";

describe("processStreamChunk", () => {
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
