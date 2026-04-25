import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StdinBuffer } from "../stdin-buffer.js";

// These tests use node:test's mock.timers to advance virtual time.
// They previously relied on wall-clock delays (delay(20), delay(150))
// racing the OS scheduler. On Windows the default setTimeout resolution is
// ~15.6ms, so a real-time delay of 20ms sometimes fired only one of two
// pending timers — hence the flake referenced in issue #4795.
//
// By mocking setTimeout/clearTimeout we control exactly when the buffer's
// sequence timeout and stale timeout fire, eliminating scheduler-induced
// flake and making the tests deterministic on every platform.

describe("StdinBuffer", () => {
	it("flushes a lone Escape keypress after the sequence timeout", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer({ timeout: 5 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));

		buffer.process("\x1b");

		// Before the timeout fires the lone ESC is still buffered.
		assert.deepEqual(received, []);
		assert.equal(buffer.getBuffer(), "\x1b");

		// Advance past the sequence timeout.
		t.mock.timers.tick(5);

		assert.deepEqual(received, ["\x1b"]);
		assert.equal(buffer.getBuffer(), "");
	});

	it("keeps split CSI focus and mouse sequences buffered until completion", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer({ timeout: 5 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));

		buffer.process("\x1b[");
		// Even after the normal timeout elapses, an incomplete CSI prefix must
		// remain buffered (not emitted as literal text) so split escape
		// sequences stay intact.
		t.mock.timers.tick(5);
		assert.deepEqual(received, []);
		assert.equal(buffer.getBuffer(), "\x1b[");

		buffer.process("I");
		assert.deepEqual(received, ["\x1b[I"]);
		assert.equal(buffer.getBuffer(), "");

		buffer.process("\x1b[<35;20;");
		t.mock.timers.tick(5);
		assert.deepEqual(received, ["\x1b[I"]);
		assert.equal(buffer.getBuffer(), "\x1b[<35;20;");

		buffer.process("5m");
		assert.deepEqual(received, ["\x1b[I", "\x1b[<35;20;5m"]);
		assert.equal(buffer.getBuffer(), "");
	});

	it("flushes a stale incomplete escape prefix after the stale timeout", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer({ timeout: 20, staleTimeout: 40 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));

		buffer.process("\x1b[");

		// Sequence timeout: keeps the incomplete prefix buffered and starts
		// the stale timer.
		t.mock.timers.tick(20);
		assert.deepEqual(received, []);
		assert.equal(buffer.getBuffer(), "\x1b[");

		// Stale timer fires — prefix is emitted as-is.
		t.mock.timers.tick(40);

		assert.deepEqual(received, ["\x1b["]);
		assert.equal(buffer.getBuffer(), "");
	});

	it("still allows an incomplete escape prefix to complete before the stale timeout", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer({ timeout: 5, staleTimeout: 30 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));

		buffer.process("\x1b[");
		// Advance past the sequence timeout (but not the stale timeout).
		t.mock.timers.tick(10);
		buffer.process("I");

		assert.deepEqual(received, ["\x1b[I"]);
		assert.equal(buffer.getBuffer(), "");
	});
});
