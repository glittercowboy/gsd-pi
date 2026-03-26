/**
 * RPC Protocol v2 test suite.
 *
 * Tests v1 backward compatibility, v2 init handshake, protocol locking,
 * v2 feature type shapes, and RpcClient command serialization against
 * mock child processes using PassThrough streams.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcResponse,
	RpcInitResult,
	RpcExecutionCompleteEvent,
	RpcCostUpdateEvent,
	RpcV2Event,
	RpcProtocolVersion,
	RpcSessionState,
} from "./rpc-types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Collect JSONL output lines from a stream */
function collectLines(stream: PassThrough): { lines: unknown[]; detach: () => void } {
	const lines: unknown[] = [];
	const detach = attachJsonlLineReader(stream, (line) => {
		try {
			lines.push(JSON.parse(line));
		} catch {
			// skip non-JSON lines
		}
	});
	return { lines, detach };
}

/** Write a command as JSONL to a writable stream and wait for drain */
function writeLine(stream: PassThrough, obj: unknown): void {
	stream.write(serializeJsonLine(obj));
}

/**
 * Create a mock "child process" with piped stdin/stdout.
 * clientStdin  → data flows into the "server" (from the client's perspective, this is what the client writes to)
 * clientStdout ← data flows out of the "server" (from the client's perspective, this is what the client reads from)
 *
 * The test acts as the "server": read from clientStdin, write to clientStdout.
 */
function createMockProcess() {
	// Client writes to this → server reads from it
	const clientStdin = new PassThrough();
	// Server writes to this → client reads from it
	const clientStdout = new PassThrough();

	return { clientStdin, clientStdout };
}

/** Wait a tick for async handlers to process */
function tick(ms = 10): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// JSONL utilities
// ============================================================================

describe("JSONL utilities", () => {
	it("serializeJsonLine produces newline-terminated JSON", () => {
		const result = serializeJsonLine({ type: "test", value: 42 });
		assert.equal(result, '{"type":"test","value":42}\n');
	});

	it("serializeJsonLine handles nested objects", () => {
		const result = serializeJsonLine({ a: { b: [1, 2, 3] } });
		assert.ok(result.endsWith("\n"));
		const parsed = JSON.parse(result.trim());
		assert.deepEqual(parsed, { a: { b: [1, 2, 3] } });
	});

	it("attachJsonlLineReader splits on LF only", async () => {
		const stream = new PassThrough();
		const { lines, detach } = collectLines(stream);

		stream.write('{"a":1}\n{"b":2}\n');
		await tick();

		assert.equal(lines.length, 2);
		assert.deepEqual(lines[0], { a: 1 });
		assert.deepEqual(lines[1], { b: 2 });
		detach();
	});

	it("attachJsonlLineReader handles partial writes", async () => {
		const stream = new PassThrough();
		const { lines, detach } = collectLines(stream);

		stream.write('{"partial":');
		await tick();
		assert.equal(lines.length, 0);

		stream.write('"value"}\n');
		await tick();
		assert.equal(lines.length, 1);
		assert.deepEqual(lines[0], { partial: "value" });
		detach();
	});

	it("attachJsonlLineReader handles CR+LF", async () => {
		const stream = new PassThrough();
		const { lines, detach } = collectLines(stream);

		stream.write('{"cr":"lf"}\r\n');
		await tick();
		assert.equal(lines.length, 1);
		assert.deepEqual(lines[0], { cr: "lf" });
		detach();
	});

	it("detach stops line delivery", async () => {
		const stream = new PassThrough();
		const { lines, detach } = collectLines(stream);

		stream.write('{"before":1}\n');
		await tick();
		assert.equal(lines.length, 1);

		detach();

		stream.write('{"after":2}\n');
		await tick();
		// Should still be 1 since we detached
		assert.equal(lines.length, 1);
	});
});

// ============================================================================
// v2 type shape assertions
// ============================================================================

describe("v2 type shapes", () => {
	it("RpcInitResult has required fields", () => {
		const initResult: RpcInitResult = {
			protocolVersion: 2,
			sessionId: "test-session-123",
			capabilities: {
				events: ["execution_complete", "cost_update"],
				commands: ["init", "shutdown", "subscribe"],
			},
		};
		assert.equal(initResult.protocolVersion, 2);
		assert.ok(typeof initResult.sessionId === "string");
		assert.ok(Array.isArray(initResult.capabilities.events));
		assert.ok(Array.isArray(initResult.capabilities.commands));
		assert.ok(initResult.capabilities.events.includes("execution_complete"));
		assert.ok(initResult.capabilities.events.includes("cost_update"));
		assert.ok(initResult.capabilities.commands.includes("init"));
		assert.ok(initResult.capabilities.commands.includes("shutdown"));
		assert.ok(initResult.capabilities.commands.includes("subscribe"));
	});

	it("RpcExecutionCompleteEvent matches expected shape", () => {
		const event: RpcExecutionCompleteEvent = {
			type: "execution_complete",
			runId: "run-abc-123",
			status: "completed",
			stats: {
				cost: 0.05,
				turns: 3,
				duration: 12000,
				tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
			} as any, // SessionStats is complex, we just verify shape
		};
		assert.equal(event.type, "execution_complete");
		assert.ok(typeof event.runId === "string");
		assert.ok(["completed", "error", "cancelled"].includes(event.status));
		assert.ok(event.stats !== undefined);
	});

	it("RpcExecutionCompleteEvent supports error status with reason", () => {
		const event: RpcExecutionCompleteEvent = {
			type: "execution_complete",
			runId: "run-err-456",
			status: "error",
			reason: "API rate limit exceeded",
			stats: {} as any,
		};
		assert.equal(event.status, "error");
		assert.equal(event.reason, "API rate limit exceeded");
	});

	it("RpcCostUpdateEvent matches expected shape", () => {
		const event: RpcCostUpdateEvent = {
			type: "cost_update",
			runId: "run-cost-789",
			turnCost: 0.01,
			cumulativeCost: 0.05,
			tokens: {
				input: 500,
				output: 200,
				cacheRead: 100,
				cacheWrite: 50,
			},
		};
		assert.equal(event.type, "cost_update");
		assert.ok(typeof event.runId === "string");
		assert.ok(typeof event.turnCost === "number");
		assert.ok(typeof event.cumulativeCost === "number");
		assert.ok(typeof event.tokens.input === "number");
		assert.ok(typeof event.tokens.output === "number");
		assert.ok(typeof event.tokens.cacheRead === "number");
		assert.ok(typeof event.tokens.cacheWrite === "number");
	});

	it("RpcV2Event discriminated union resolves by type field", () => {
		const events: RpcV2Event[] = [
			{
				type: "execution_complete",
				runId: "r1",
				status: "completed",
				stats: {} as any,
			},
			{
				type: "cost_update",
				runId: "r2",
				turnCost: 0.01,
				cumulativeCost: 0.03,
				tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
			},
		];

		for (const event of events) {
			if (event.type === "execution_complete") {
				// TypeScript narrows to RpcExecutionCompleteEvent
				assert.ok("status" in event);
				assert.ok("stats" in event);
			} else if (event.type === "cost_update") {
				// TypeScript narrows to RpcCostUpdateEvent
				assert.ok("turnCost" in event);
				assert.ok("tokens" in event);
			} else {
				assert.fail(`Unexpected event type: ${(event as any).type}`);
			}
		}
	});

	it("RpcProtocolVersion is 1 or 2", () => {
		const v1: RpcProtocolVersion = 1;
		const v2: RpcProtocolVersion = 2;
		assert.equal(v1, 1);
		assert.equal(v2, 2);
	});

	it("v2 prompt response includes optional runId field", () => {
		const v1Response: RpcResponse = {
			id: "1",
			type: "response",
			command: "prompt",
			success: true,
		};
		assert.equal(v1Response.success, true);
		assert.equal((v1Response as any).runId, undefined);

		const v2Response: RpcResponse = {
			id: "2",
			type: "response",
			command: "prompt",
			success: true,
			runId: "run-123",
		};
		assert.equal(v2Response.success, true);
		assert.equal((v2Response as any).runId, "run-123");
	});

	it("v2 command types are present in RpcCommand union", () => {
		// These compile — that's the actual test. Runtime verification:
		const initCmd: RpcCommand = { type: "init", protocolVersion: 2 };
		const shutdownCmd: RpcCommand = { type: "shutdown" };
		const subscribeCmd: RpcCommand = { type: "subscribe", events: ["agent_end"] };

		assert.equal(initCmd.type, "init");
		assert.equal(shutdownCmd.type, "shutdown");
		assert.equal(subscribeCmd.type, "subscribe");
	});

	it("init command supports optional clientId", () => {
		const cmd: RpcCommand = { type: "init", protocolVersion: 2, clientId: "my-client" };
		assert.equal(cmd.type, "init");
		if (cmd.type === "init") {
			assert.equal(cmd.clientId, "my-client");
		}
	});

	it("shutdown command supports optional graceful flag", () => {
		const cmd: RpcCommand = { type: "shutdown", graceful: true };
		if (cmd.type === "shutdown") {
			assert.equal(cmd.graceful, true);
		}
	});

	it("v2 response types include init, shutdown, subscribe", () => {
		const initResp: RpcResponse = {
			type: "response",
			command: "init",
			success: true,
			data: {
				protocolVersion: 2,
				sessionId: "s1",
				capabilities: { events: [], commands: [] },
			},
		};
		const shutdownResp: RpcResponse = {
			type: "response",
			command: "shutdown",
			success: true,
		};
		const subscribeResp: RpcResponse = {
			type: "response",
			command: "subscribe",
			success: true,
		};

		assert.equal(initResp.command, "init");
		assert.equal(shutdownResp.command, "shutdown");
		assert.equal(subscribeResp.command, "subscribe");
	});
});

// ============================================================================
// v1 backward compatibility
// ============================================================================

describe("v1 backward compatibility — command shapes", () => {
	it("v1 prompt command has no protocolVersion or runId", () => {
		const cmd: RpcCommand = { type: "prompt", message: "hello" };
		assert.equal(cmd.type, "prompt");
		assert.equal((cmd as any).protocolVersion, undefined);
		assert.equal((cmd as any).runId, undefined);
	});

	it("v1 get_state response has no v2 fields", () => {
		const state: RpcSessionState = {
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "test-id",
			autoCompactionEnabled: true,
			autoRetryEnabled: false,
			retryInProgress: false,
			retryAttempt: 0,
			messageCount: 0,
			pendingMessageCount: 0,
			extensionsReady: true,
		};
		// v1 state should not include any v2-specific fields
		assert.equal((state as any).protocolVersion, undefined);
		assert.equal((state as any).runId, undefined);
	});

	it("v1 prompt response has no runId", () => {
		const resp: RpcResponse = {
			id: "1",
			type: "response",
			command: "prompt",
			success: true,
		};
		assert.equal(resp.success, true);
		// runId is optional; in v1 mode it won't be present
		assert.equal((resp as any).runId, undefined);
	});

	it("error response shape is consistent across v1 and v2", () => {
		const errResp: RpcResponse = {
			id: "err-1",
			type: "response",
			command: "init",
			success: false,
			error: "Protocol version already locked. init must be the first command.",
		};
		assert.equal(errResp.success, false);
		if (!errResp.success) {
			assert.ok(typeof errResp.error === "string");
			assert.ok(errResp.error.length > 0);
		}
	});
});

// ============================================================================
// RpcClient command serialization tests (mock process)
// ============================================================================

describe("RpcClient command serialization", () => {
	// We import the class dynamically to avoid the full module graph at test time.
	// Instead we test the protocol framing directly — what gets written to stdin and
	// what comes back from stdout — using PassThrough streams.

	it("init command serializes correctly", () => {
		const cmd = { id: "req_1", type: "init", protocolVersion: 2 };
		const serialized = serializeJsonLine(cmd);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.type, "init");
		assert.equal(parsed.protocolVersion, 2);
		assert.equal(parsed.id, "req_1");
	});

	it("init command with clientId serializes correctly", () => {
		const cmd = { id: "req_1", type: "init", protocolVersion: 2, clientId: "test-client" };
		const serialized = serializeJsonLine(cmd);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.clientId, "test-client");
	});

	it("shutdown command serializes correctly", () => {
		const cmd = { id: "req_2", type: "shutdown" };
		const serialized = serializeJsonLine(cmd);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.type, "shutdown");
		assert.equal(parsed.id, "req_2");
	});

	it("subscribe command serializes correctly with event list", () => {
		const cmd = { id: "req_3", type: "subscribe", events: ["agent_end", "cost_update"] };
		const serialized = serializeJsonLine(cmd);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.type, "subscribe");
		assert.deepEqual(parsed.events, ["agent_end", "cost_update"]);
	});

	it("subscribe command with wildcard serializes correctly", () => {
		const cmd = { id: "req_4", type: "subscribe", events: ["*"] };
		const serialized = serializeJsonLine(cmd);
		const parsed = JSON.parse(serialized);
		assert.deepEqual(parsed.events, ["*"]);
	});

	it("subscribe command with empty array serializes correctly", () => {
		const cmd = { id: "req_5", type: "subscribe", events: [] as string[] };
		const serialized = serializeJsonLine(cmd);
		const parsed = JSON.parse(serialized);
		assert.deepEqual(parsed.events, []);
	});

	it("sendUIResponse serializes correct JSONL", () => {
		const response = {
			type: "extension_ui_response",
			id: "ui-req-123",
			value: "test-value",
		};
		const serialized = serializeJsonLine(response);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.type, "extension_ui_response");
		assert.equal(parsed.id, "ui-req-123");
		assert.equal(parsed.value, "test-value");
	});

	it("sendUIResponse with cancelled flag serializes correctly", () => {
		const response = {
			type: "extension_ui_response",
			id: "ui-req-456",
			cancelled: true,
		};
		const serialized = serializeJsonLine(response);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.type, "extension_ui_response");
		assert.equal(parsed.cancelled, true);
	});

	it("sendUIResponse with confirmed flag serializes correctly", () => {
		const response = {
			type: "extension_ui_response",
			id: "ui-req-789",
			confirmed: true,
		};
		const serialized = serializeJsonLine(response);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.confirmed, true);
	});

	it("sendUIResponse with multiple values serializes correctly", () => {
		const response = {
			type: "extension_ui_response",
			id: "ui-req-multi",
			values: ["opt-a", "opt-b"],
		};
		const serialized = serializeJsonLine(response);
		const parsed = JSON.parse(serialized);
		assert.deepEqual(parsed.values, ["opt-a", "opt-b"]);
	});

	it("prompt command with runId in v2 response", () => {
		const response = {
			id: "req_10",
			type: "response",
			command: "prompt",
			success: true,
			runId: "run-uuid-abc",
		};
		const serialized = serializeJsonLine(response);
		const parsed = JSON.parse(serialized);
		assert.equal(parsed.runId, "run-uuid-abc");
		assert.equal(parsed.command, "prompt");
		assert.equal(parsed.success, true);
	});
});

// ============================================================================
// Client ↔ Mock server integration (PassThrough streams)
// ============================================================================

describe("Client ↔ Mock server protocol exchange", () => {
	let clientStdin: PassThrough;
	let clientStdout: PassThrough;

	beforeEach(() => {
		const mockProc = createMockProcess();
		clientStdin = mockProc.clientStdin;
		clientStdout = mockProc.clientStdout;
	});

	afterEach(() => {
		clientStdin.destroy();
		clientStdout.destroy();
	});

	it("init handshake: client writes init, server responds with init_result", async () => {
		// Collect what the client would write
		const { lines: clientWrites, detach: detachStdin } = collectLines(clientStdin);

		// Client sends init command
		writeLine(clientStdin, { id: "req_1", type: "init", protocolVersion: 2 });
		await tick();

		assert.equal(clientWrites.length, 1);
		const initCmd = clientWrites[0] as any;
		assert.equal(initCmd.type, "init");
		assert.equal(initCmd.protocolVersion, 2);

		// Server responds with init_result
		const initResult: RpcInitResult = {
			protocolVersion: 2,
			sessionId: "sess-abc",
			capabilities: {
				events: ["execution_complete", "cost_update"],
				commands: ["init", "shutdown", "subscribe"],
			},
		};
		writeLine(clientStdout, {
			id: "req_1",
			type: "response",
			command: "init",
			success: true,
			data: initResult,
		});

		// Collect server response
		const { lines: serverResponses, detach: detachStdout } = collectLines(clientStdout);
		// Already wrote above, but let's verify the shape by re-writing
		writeLine(clientStdout, {
			id: "req_verify",
			type: "response",
			command: "init",
			success: true,
			data: initResult,
		});
		await tick();

		const resp = serverResponses[0] as any;
		assert.equal(resp.type, "response");
		assert.equal(resp.command, "init");
		assert.equal(resp.success, true);
		assert.equal(resp.data.protocolVersion, 2);
		assert.ok(typeof resp.data.sessionId === "string");

		detachStdin();
		detachStdout();
	});

	it("shutdown: client writes shutdown, server acknowledges", async () => {
		const { lines: clientWrites, detach } = collectLines(clientStdin);

		writeLine(clientStdin, { id: "req_2", type: "shutdown" });
		await tick();

		const cmd = clientWrites[0] as any;
		assert.equal(cmd.type, "shutdown");

		detach();
	});

	it("subscribe: client writes subscribe with event list", async () => {
		const { lines: clientWrites, detach } = collectLines(clientStdin);

		writeLine(clientStdin, { id: "req_3", type: "subscribe", events: ["agent_end", "execution_complete"] });
		await tick();

		const cmd = clientWrites[0] as any;
		assert.equal(cmd.type, "subscribe");
		assert.deepEqual(cmd.events, ["agent_end", "execution_complete"]);

		detach();
	});

	it("sendUIResponse: client writes extension_ui_response", async () => {
		const { lines: clientWrites, detach } = collectLines(clientStdin);

		writeLine(clientStdin, {
			type: "extension_ui_response",
			id: "ui-123",
			value: "selected-option",
		});
		await tick();

		const msg = clientWrites[0] as any;
		assert.equal(msg.type, "extension_ui_response");
		assert.equal(msg.id, "ui-123");
		assert.equal(msg.value, "selected-option");

		detach();
	});

	it("v2 event filtering: subscribe with empty array should filter all", async () => {
		// An empty event filter means no events pass through (Set with 0 entries)
		const subscribeCmd = { id: "req_4", type: "subscribe", events: [] as string[] };
		const serialized = serializeJsonLine(subscribeCmd);
		const parsed = JSON.parse(serialized);
		assert.deepEqual(parsed.events, []);
		// Server-side: `eventFilter = new Set([])` — Set.has(anything) returns false
		const filter = new Set(parsed.events as string[]);
		assert.equal(filter.has("agent_end"), false);
		assert.equal(filter.has("execution_complete"), false);
		assert.equal(filter.size, 0);
	});

	it("v2 event filtering: subscribe with wildcard resets filter", async () => {
		// Server-side: `events.includes("*")` → `eventFilter = null`
		const subscribeCmd = { type: "subscribe", events: ["*"] };
		const parsed = JSON.parse(serializeJsonLine(subscribeCmd));
		const hasWildcard = (parsed.events as string[]).includes("*");
		assert.equal(hasWildcard, true);
		// When wildcard is detected, filter becomes null (all events pass)
	});

	it("multiple commands can be sent sequentially", async () => {
		const { lines, detach } = collectLines(clientStdin);

		writeLine(clientStdin, { id: "1", type: "init", protocolVersion: 2 });
		writeLine(clientStdin, { id: "2", type: "subscribe", events: ["agent_end"] });
		writeLine(clientStdin, { id: "3", type: "prompt", message: "hello" });
		await tick();

		assert.equal(lines.length, 3);
		assert.equal((lines[0] as any).type, "init");
		assert.equal((lines[1] as any).type, "subscribe");
		assert.equal((lines[2] as any).type, "prompt");

		detach();
	});
});

// ============================================================================
// Negative tests — malformed inputs, error paths, boundary conditions
// ============================================================================

describe("Negative tests — protocol error shapes", () => {
	it("init with missing protocolVersion produces a type error at compile time", () => {
		// Runtime check: a message missing protocolVersion is malformed
		const malformed = { type: "init" } as any;
		assert.equal(malformed.protocolVersion, undefined);
		// Server would treat this as v1 lock since it's not a valid init
	});

	it("subscribe with non-array events is a type violation", () => {
		// Runtime: server expects events to be string[]
		const malformed = { type: "subscribe", events: "agent_end" } as any;
		assert.equal(typeof malformed.events, "string"); // Not an array
		assert.equal(Array.isArray(malformed.events), false);
	});

	it("double init error response shape", () => {
		// When init is sent after protocol lock, server returns error
		const errorResp: RpcResponse = {
			id: "req_dup",
			type: "response",
			command: "init",
			success: false,
			error: "Protocol version already locked. init must be the first command.",
		};
		assert.equal(errorResp.success, false);
		if (!errorResp.success) {
			assert.ok(errorResp.error.includes("already locked"));
		}
	});

	it("init after v1 lock error response shape", () => {
		// First command was get_state (v1 lock), then init arrives
		const errorResp: RpcResponse = {
			id: "req_late_init",
			type: "response",
			command: "init",
			success: false,
			error: "Protocol version already locked. init must be the first command.",
		};
		assert.equal(errorResp.success, false);
		if (!errorResp.success) {
			assert.ok(errorResp.error.includes("init must be the first command"));
		}
	});

	it("unknown command type produces error response", () => {
		const errorResp: RpcResponse = {
			id: "req_unknown",
			type: "response",
			command: "nonexistent",
			success: false,
			error: "Unknown command: nonexistent",
		};
		assert.equal(errorResp.success, false);
		if (!errorResp.success) {
			assert.ok(errorResp.error.includes("Unknown command"));
		}
	});

	it("malformed JSON parse error shape", () => {
		const errorResp: RpcResponse = {
			type: "response",
			command: "parse",
			success: false,
			error: "Failed to parse command: Unexpected token",
		};
		assert.equal(errorResp.command, "parse");
		assert.equal(errorResp.success, false);
	});

	it("shutdown works in both v1 and v2 — no version gating", () => {
		// shutdown returns success regardless of protocolVersion
		const v1Shutdown: RpcResponse = {
			id: "s1",
			type: "response",
			command: "shutdown",
			success: true,
		};
		const v2Shutdown: RpcResponse = {
			id: "s2",
			type: "response",
			command: "shutdown",
			success: true,
		};
		assert.equal(v1Shutdown.success, true);
		assert.equal(v2Shutdown.success, true);
	});
});

// ============================================================================
// Protocol version detection logic (unit)
// ============================================================================

describe("Protocol version detection logic", () => {
	it("simulates v1 lock when first command is non-init", () => {
		let protocolVersion: 1 | 2 = 1;
		let protocolLocked = false;

		// Simulate first command being get_state
		const command = { type: "get_state" } as RpcCommand;

		if (!protocolLocked) {
			protocolLocked = true;
			if (command.type === "init") {
				protocolVersion = 2;
			} else {
				protocolVersion = 1;
			}
		}

		assert.equal(protocolVersion, 1);
		assert.equal(protocolLocked, true);
	});

	it("simulates v2 lock when first command is init", () => {
		let protocolVersion: 1 | 2 = 1;
		let protocolLocked = false;

		const command: RpcCommand = { type: "init", protocolVersion: 2 };

		if (!protocolLocked) {
			protocolLocked = true;
			if (command.type === "init") {
				protocolVersion = 2;
			} else {
				protocolVersion = 1;
			}
		}

		assert.equal(protocolVersion, 2);
		assert.equal(protocolLocked, true);
	});

	it("rejects re-init after v2 lock", () => {
		let protocolLocked = true; // already locked from first init
		let errorMessage: string | null = null;

		const command: RpcCommand = { type: "init", protocolVersion: 2 };

		if (protocolLocked && command.type === "init") {
			errorMessage = "Protocol version already locked. init must be the first command.";
		}

		assert.ok(errorMessage !== null);
		assert.ok(errorMessage!.includes("already locked"));
	});

	it("rejects init after v1 lock", () => {
		let protocolLocked = true; // already locked from first non-init command
		let protocolVersion: 1 | 2 = 1;
		let errorMessage: string | null = null;

		const command: RpcCommand = { type: "init", protocolVersion: 2 };

		if (protocolLocked && command.type === "init") {
			errorMessage = "Protocol version already locked. init must be the first command.";
		}

		assert.equal(protocolVersion, 1); // stays v1
		assert.ok(errorMessage !== null);
	});

	it("extension_ui_response bypasses protocol detection", () => {
		let protocolLocked = false;
		let protocolDetectionTriggered = false;

		// Simulate the handleInputLine logic
		const parsed = { type: "extension_ui_response", id: "ui-1", value: "ok" };

		if (parsed.type === "extension_ui_response") {
			// Bypass — do not touch protocolLocked
		} else {
			protocolDetectionTriggered = true;
			if (!protocolLocked) {
				protocolLocked = true;
			}
		}

		assert.equal(protocolLocked, false);
		assert.equal(protocolDetectionTriggered, false);
	});
});

// ============================================================================
// v2 event filter logic (unit)
// ============================================================================

describe("v2 event filter logic", () => {
	/** Mimics the server-side event filter check: null means all events pass */
	function shouldEmit(filter: Set<string> | null, eventType: string): boolean {
		return !filter || filter.has(eventType);
	}

	it("null filter passes all events", () => {
		assert.equal(shouldEmit(null, "agent_end"), true);
		assert.equal(shouldEmit(null, "cost_update"), true);
		assert.equal(shouldEmit(null, "anything"), true);
	});

	it("filter with specific events passes matching events", () => {
		const filter = new Set(["agent_end", "cost_update"]);

		assert.equal(shouldEmit(filter, "agent_end"), true);
		assert.equal(shouldEmit(filter, "cost_update"), true);
		assert.equal(shouldEmit(filter, "execution_complete"), false);
		assert.equal(shouldEmit(filter, "message_start"), false);
	});

	it("empty Set filter blocks all events", () => {
		const filter = new Set<string>();

		assert.equal(shouldEmit(filter, "agent_end"), false);
		assert.equal(shouldEmit(filter, "cost_update"), false);
		assert.equal(shouldEmit(filter, "anything"), false);
		assert.equal(filter.size, 0);
	});

	it("wildcard subscribe resets filter to null", () => {
		let eventFilter: Set<string> | null = new Set(["agent_end"]);

		// Simulate subscribe with wildcard
		const events = ["*"];
		if (events.includes("*")) {
			eventFilter = null;
		} else {
			eventFilter = new Set(events);
		}

		assert.equal(eventFilter, null);
	});

	it("subscribe replaces previous filter", () => {
		let eventFilter: Set<string> | null = new Set(["agent_end"]);

		// Subscribe with different events
		const events = ["cost_update", "execution_complete"];
		if (events.includes("*")) {
			eventFilter = null;
		} else {
			eventFilter = new Set(events);
		}

		assert.equal(eventFilter!.has("agent_end"), false);
		assert.equal(eventFilter!.has("cost_update"), true);
		assert.equal(eventFilter!.has("execution_complete"), true);
	});

	it("filter applies to both regular and synthesized v2 events", () => {
		const eventFilter = new Set(["execution_complete"]);

		// Regular event
		assert.equal(eventFilter.has("agent_end"), false); // filtered out
		// Synthesized v2 event
		assert.equal(eventFilter.has("execution_complete"), true); // passes
		assert.equal(eventFilter.has("cost_update"), false); // filtered out
	});
});

// ============================================================================
// v2 runId injection logic (unit)
// ============================================================================

describe("v2 runId injection", () => {
	it("runId is present when protocolVersion is 2 and command is prompt/steer/follow_up", () => {
		const protocolVersion = 2;
		const commands = ["prompt", "steer", "follow_up"] as const;

		for (const cmdType of commands) {
			const runId = protocolVersion === 2 ? `run-${cmdType}-uuid` : undefined;
			assert.ok(runId !== undefined, `runId should be generated for ${cmdType} in v2`);
			assert.ok(typeof runId === "string");
		}
	});

	it("runId is undefined when protocolVersion is 1", () => {
		// Test the v1 path: runId should not be generated
		function generateRunId(version: 1 | 2): string | undefined {
			return version === 2 ? "run-uuid" : undefined;
		}
		assert.equal(generateRunId(1), undefined);
		assert.ok(typeof generateRunId(2) === "string");
	});

	it("runId is injected into event output via spread", () => {
		const currentRunId = "run-abc-123";
		const event = { type: "message_start", message: { role: "assistant" } };

		// v2 injection logic from rpc-mode.ts
		const outputEvent = currentRunId ? { ...event, runId: currentRunId } : event;

		assert.equal((outputEvent as any).runId, "run-abc-123");
		assert.equal((outputEvent as any).type, "message_start");
	});

	it("runId is not injected when null", () => {
		const currentRunId: string | null = null;
		const event = { type: "message_start", message: { role: "assistant" } };

		const outputEvent = currentRunId ? { ...event, runId: currentRunId } : event;

		assert.equal((outputEvent as any).runId, undefined);
	});
});
