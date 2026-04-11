import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { StdinBuffer } from "../stdin-buffer.js";

describe("StdinBuffer", () => {
	it("flushes a lone Escape keypress", async () => {
		const buffer = new StdinBuffer({ timeout: 5 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));

		buffer.process("\x1b");
		await delay(20);

		assert.deepEqual(received, ["\x1b"]);
		assert.equal(buffer.getBuffer(), "");
	});

	it("keeps split CSI focus and mouse sequences buffered until completion", async () => {
		const buffer = new StdinBuffer({ timeout: 5 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));

		buffer.process("\x1b[");
		await delay(20);
		assert.deepEqual(received, []);
		assert.equal(buffer.getBuffer(), "\x1b[");

		buffer.process("I");
		assert.deepEqual(received, ["\x1b[I"]);
		assert.equal(buffer.getBuffer(), "");

		buffer.process("\x1b[<35;20;");
		await delay(20);
		assert.deepEqual(received, ["\x1b[I"]);
		assert.equal(buffer.getBuffer(), "\x1b[<35;20;");

		buffer.process("5m");
		assert.deepEqual(received, ["\x1b[I", "\x1b[<35;20;5m"]);
		assert.equal(buffer.getBuffer(), "");
	});
});
