// @gsd/pi-coding-agent + token-telemetry.test — coverage for #5023.
// Verifies the env-gated emitter:
//   - is silent by default (no behavior change for existing users)
//   - emits a single valid JSON line when PI_TOKEN_TELEMETRY=1
//   - record shape captures the cache breakdown the providers already extract
//   - cacheHitRatio math is correct, including the no-input edge case

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { AssistantMessage } from "@gsd/pi-ai";

import { buildTokenTelemetryRecord, emitTokenTelemetry } from "../core/token-telemetry.js";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.3, output: 0.75, cacheRead: 0, cacheWrite: 0, total: 1.05 },
		},
		stopReason: "stop",
		timestamp: 1700000000000,
		...overrides,
	};
}

// ─── buildTokenTelemetryRecord ─────────────────────────────────────────────

describe("buildTokenTelemetryRecord", () => {
	test("captures all fields from a typical message", () => {
		const msg = makeAssistantMessage();
		const record = buildTokenTelemetryRecord(msg);
		assert.deepEqual(record, {
			ts: 1700000000000,
			model: "claude-sonnet-4-6",
			stopReason: "stop",
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			costTotal: 1.05,
			cacheHitRatio: 0,
		});
	});

	test("cacheHitRatio = read / (read + input) when both present", () => {
		const msg = makeAssistantMessage({
			usage: {
				input: 200,
				output: 50,
				cacheRead: 800,
				cacheWrite: 0,
				totalTokens: 1050,
				cost: { input: 0.6, output: 0.75, cacheRead: 0.24, cacheWrite: 0, total: 1.59 },
			},
		});
		const record = buildTokenTelemetryRecord(msg);
		assert.equal(record.cacheRead, 800);
		assert.equal(record.input, 200);
		assert.equal(record.cacheHitRatio, 0.8);
	});

	test("cacheHitRatio = 0 when both read and input are 0 (no division-by-zero)", () => {
		const msg = makeAssistantMessage({
			usage: {
				input: 0,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 50,
				cost: { input: 0, output: 0.75, cacheRead: 0, cacheWrite: 0, total: 0.75 },
			},
		});
		const record = buildTokenTelemetryRecord(msg);
		assert.equal(record.cacheHitRatio, 0);
	});

	test("cacheHitRatio = 1 when only cacheRead present (full hit)", () => {
		const msg = makeAssistantMessage({
			usage: {
				input: 0,
				output: 50,
				cacheRead: 5000,
				cacheWrite: 0,
				totalTokens: 5050,
				cost: { input: 0, output: 0.75, cacheRead: 1.5, cacheWrite: 0, total: 2.25 },
			},
		});
		const record = buildTokenTelemetryRecord(msg);
		assert.equal(record.cacheHitRatio, 1);
	});

	test("cacheWrite is captured (the cache-miss-with-cache-control case from #5019)", () => {
		const msg = makeAssistantMessage({
			usage: {
				input: 50,
				output: 100,
				cacheRead: 0,
				cacheWrite: 5000,
				totalTokens: 5150,
				cost: { input: 0.15, output: 1.5, cacheRead: 0, cacheWrite: 18.75, total: 20.4 },
			},
		});
		const record = buildTokenTelemetryRecord(msg);
		assert.equal(record.cacheWrite, 5000);
		assert.equal(record.cacheHitRatio, 0, "no read = ratio 0 even when write is large");
	});

	test("error stopReason is captured verbatim", () => {
		const msg = makeAssistantMessage({ stopReason: "error", errorMessage: "rate_limit" });
		assert.equal(buildTokenTelemetryRecord(msg).stopReason, "error");
	});
});

// ─── emitTokenTelemetry ────────────────────────────────────────────────────

describe("emitTokenTelemetry", () => {
	let captured: string[];
	let originalWrite: typeof process.stderr.write;
	let originalEnv: string | undefined;

	beforeEach(() => {
		captured = [];
		originalWrite = process.stderr.write.bind(process.stderr);
		// Replace stderr.write with a capture; preserve the same return contract.
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stderr.write;
		originalEnv = process.env.PI_TOKEN_TELEMETRY;
	});

	afterEach(() => {
		process.stderr.write = originalWrite;
		if (originalEnv === undefined) {
			delete process.env.PI_TOKEN_TELEMETRY;
		} else {
			process.env.PI_TOKEN_TELEMETRY = originalEnv;
		}
	});

	test("silent by default (env var unset)", () => {
		delete process.env.PI_TOKEN_TELEMETRY;
		emitTokenTelemetry(makeAssistantMessage());
		assert.equal(captured.length, 0);
	});

	test("silent when env var has any non-'1' value", () => {
		process.env.PI_TOKEN_TELEMETRY = "true"; // not literally "1"
		emitTokenTelemetry(makeAssistantMessage());
		assert.equal(captured.length, 0, "only literal '1' should enable telemetry");
	});

	test("emits a single JSON line when PI_TOKEN_TELEMETRY=1", () => {
		process.env.PI_TOKEN_TELEMETRY = "1";
		emitTokenTelemetry(makeAssistantMessage());
		assert.equal(captured.length, 1);
		assert.ok(captured[0].endsWith("\n"), "line must terminate with newline");
		const parsed = JSON.parse(captured[0].trimEnd());
		assert.equal(parsed.model, "claude-sonnet-4-6");
		assert.equal(parsed.input, 100);
		assert.equal(parsed.output, 50);
	});

	test("emitted JSON has the documented shape", () => {
		process.env.PI_TOKEN_TELEMETRY = "1";
		emitTokenTelemetry(makeAssistantMessage());
		const parsed = JSON.parse(captured[0].trimEnd());
		const keys = Object.keys(parsed).sort();
		assert.deepEqual(keys, [
			"cacheHitRatio",
			"cacheRead",
			"cacheWrite",
			"costTotal",
			"input",
			"model",
			"output",
			"stopReason",
			"ts",
		]);
	});

	test("never throws — telemetry must not break the agent loop", () => {
		process.env.PI_TOKEN_TELEMETRY = "1";
		// Force a write failure to exercise the swallow path.
		process.stderr.write = (() => {
			throw new Error("simulated stderr failure");
		}) as typeof process.stderr.write;
		assert.doesNotThrow(() => emitTokenTelemetry(makeAssistantMessage()));
	});
});
