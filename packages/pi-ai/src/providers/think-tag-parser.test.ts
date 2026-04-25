import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThinkTagParser } from "./think-tag-parser.js";

describe("ThinkTagParser", () => {
	it("keeps plain text untouched", () => {
		const parser = new ThinkTagParser();
		assert.deepEqual(parser.consume("hello world"), [{ type: "text", text: "hello world" }]);
		assert.deepEqual(parser.flush(), []);
	});

	it("splits inline think tags into thinking segments", () => {
		const parser = new ThinkTagParser();
		const out = parser.consume("A<think>B</think>C");
		assert.deepEqual(out, [
			{ type: "text", text: "A" },
			{ type: "thinking", text: "B" },
			{ type: "text", text: "C" },
		]);
	});

	it("handles tag boundaries across deltas", () => {
		const parser = new ThinkTagParser();
		const out1 = parser.consume("A<th");
		const out2 = parser.consume("ink>B</thi");
		const out3 = parser.consume("nk>C");
		const out4 = parser.flush();
		assert.deepEqual([...out1, ...out2, ...out3, ...out4], [
			{ type: "text", text: "A" },
			{ type: "thinking", text: "B" },
			{ type: "text", text: "C" },
		]);
	});

	it("flushes unclosed think blocks as thinking", () => {
		const parser = new ThinkTagParser();
		const out1 = parser.consume("A<think>partial");
		const out2 = parser.flush();
		assert.deepEqual([...out1, ...out2], [
			{ type: "text", text: "A" },
			{ type: "thinking", text: "partial" },
		]);
	});
});
