import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { serializeJsonLine, attachJsonlLineReader } from "./jsonl.js";
import type {
	RpcInitResult,
	RpcExecutionCompleteEvent,
	RpcCostUpdateEvent,
	RpcProtocolVersion,
	SessionStats,
	RpcV2Event,
} from "./rpc-types.js";
import { RpcClient } from "./rpc-client.js";
import type { SdkAgentEvent } from "./rpc-client.js";

/**
 * Flush pending microtasks and one turn of the macrotask queue.
 *
 * Used in places where the test needs "every already-queued stream event has
 * been delivered" — cheaper than a wall-clock sleep and deterministic because
 * `setImmediate` runs strictly after any I/O callbacks already queued by a
 * synchronous `stream.write(...)`.
 */
function flushIO(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// JSONL Tests
// ============================================================================

describe("serializeJsonLine", () => {
	it("produces valid JSON terminated with LF", () => {
		const result = serializeJsonLine({ type: "test", value: 42 });
		assert.ok(result.endsWith("\n"), "must end with LF");
		const parsed = JSON.parse(result.trim());
		assert.equal(parsed.type, "test");
		assert.equal(parsed.value, 42);
	});

	it("serializes strings with special characters", () => {
		const result = serializeJsonLine({ msg: "hello\nworld" });
		assert.ok(result.endsWith("\n"));
		// The embedded \n must be escaped inside the JSON — only the trailing LF is the framing delimiter
		const lines = result.split("\n");
		// Should be exactly 2 parts: the JSON line and the empty string after trailing LF
		assert.equal(lines.length, 2);
		assert.equal(lines[1], "");
		const parsed = JSON.parse(lines[0]);
		assert.equal(parsed.msg, "hello\nworld");
	});

	it("handles empty objects", () => {
		const result = serializeJsonLine({});
		assert.equal(result, "{}\n");
	});
});

describe("attachJsonlLineReader", () => {
	it("splits on LF correctly", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];

		attachJsonlLineReader(stream, (line) => lines.push(line));

		stream.write('{"a":1}\n{"b":2}\n');
		stream.end();

		// The reader registers its `end` listener first; awaiting `end` here
		// runs strictly after the reader has drained any trailing buffer.
		await once(stream, "end");

		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[0]).a, 1);
		assert.equal(JSON.parse(lines[1]).b, 2);
	});

	it("handles chunked data across boundaries", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];

		attachJsonlLineReader(stream, (line) => lines.push(line));

		// Write in fragments that split mid-line
		stream.write('{"type":"hel');
		stream.write('lo"}\n{"type":"w');
		stream.write('orld"}\n');
		stream.end();

		await once(stream, "end");

		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[0]).type, "hello");
		assert.equal(JSON.parse(lines[1]).type, "world");
	});

	it("emits trailing data on stream end", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];

		attachJsonlLineReader(stream, (line) => lines.push(line));

		stream.write('{"final":true}');
		stream.end();

		await once(stream, "end");

		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).final, true);
	});

	it("returns a detach function that stops reading", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];

		// Use an explicit promise to signal "first line has been observed".
		// This is deterministic — we resume exactly when the reader fires the
		// callback, not after an arbitrary wall-clock delay.
		let signalFirstLine!: () => void;
		const firstLineSeen = new Promise<void>((resolve) => {
			signalFirstLine = resolve;
		});

		const detach = attachJsonlLineReader(stream, (line) => {
			lines.push(line);
			if (lines.length === 1) signalFirstLine();
		});

		stream.write('{"a":1}\n');
		await firstLineSeen;
		assert.equal(lines.length, 1);

		detach();

		stream.write('{"b":2}\n');
		stream.end();
		// Drain any queued data events post-detach. `setImmediate` runs strictly
		// after any 'data' events that were already queued by the write above.
		await flushIO();

		// Should still be 1 — detach removed listeners
		assert.equal(lines.length, 1);
	});

	it("strips CR from CRLF line endings", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];

		attachJsonlLineReader(stream, (line) => lines.push(line));

		stream.write('{"v":1}\r\n');
		stream.end();

		await once(stream, "end");

		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).v, 1);
	});
});

// ============================================================================
// JSONL Round-Trip Tests
//
// These previously lived under a "type shapes" block that only asserted that
// a typed literal retained its own field values — pure type-system
// tautologies. They are now replaced with round-trips through
// `serializeJsonLine` + `JSON.parse`, which exercises the actual framing
// pipeline the wire protocol uses. A regression where `serializeJsonLine`
// mangles payloads or the LF terminator will now fail these tests.
// ============================================================================

describe("JSONL round-trip of v2 payloads", () => {
	function roundTrip<T>(value: T): T {
		const serialized = serializeJsonLine(value);
		assert.ok(serialized.endsWith("\n"), "wire format must terminate with LF");
		// Ensure we did not emit embedded unescaped LFs that would corrupt framing
		assert.equal(serialized.indexOf("\n"), serialized.length - 1, "no unescaped LF inside payload");
		return JSON.parse(serialized.trim()) as T;
	}

	it("RpcInitResult round-trips through serializeJsonLine", () => {
		const init: RpcInitResult = {
			protocolVersion: 2,
			sessionId: "sess_123",
			capabilities: {
				events: ["execution_complete", "cost_update"],
				commands: ["prompt", "steer"],
			},
		};
		const parsed = roundTrip(init);
		assert.deepEqual(parsed, init);
	});

	it("RpcExecutionCompleteEvent round-trips preserving nested stats", () => {
		const event: RpcExecutionCompleteEvent = {
			type: "execution_complete",
			runId: "run_abc",
			status: "completed",
			stats: {
				sessionFile: "/tmp/session.json",
				sessionId: "sess_123",
				userMessages: 5,
				assistantMessages: 5,
				toolCalls: 3,
				toolResults: 3,
				totalMessages: 10,
				tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
				cost: 0.05,
			},
		};
		const parsed = roundTrip(event);
		assert.deepEqual(parsed, event);
	});

	it("RpcCostUpdateEvent round-trips with numeric precision intact", () => {
		const event: RpcCostUpdateEvent = {
			type: "cost_update",
			runId: "run_abc",
			turnCost: 0.01,
			cumulativeCost: 0.05,
			tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50 },
		};
		const parsed = roundTrip(event);
		assert.deepEqual(parsed, event);
	});

	it("SessionStats round-trips preserving totals", () => {
		const stats: SessionStats = {
			sessionFile: "/tmp/session.json",
			sessionId: "s1",
			userMessages: 10,
			assistantMessages: 10,
			toolCalls: 5,
			toolResults: 5,
			totalMessages: 20,
			tokens: { input: 2000, output: 1000, cacheRead: 500, cacheWrite: 200, total: 3700 },
			cost: 0.1,
		};
		const parsed = roundTrip(stats);
		assert.deepEqual(parsed, stats);
		assert.equal(
			parsed.tokens.input + parsed.tokens.output + parsed.tokens.cacheRead + parsed.tokens.cacheWrite,
			parsed.tokens.total,
			"tokens.total should equal the sum of components after round-trip",
		);
	});

	it("RpcProtocolVersion values 1 and 2 survive round-trip", () => {
		const v1: RpcProtocolVersion = 1;
		const v2: RpcProtocolVersion = 2;
		assert.strictEqual(roundTrip({ v: v1 }).v, 1);
		assert.strictEqual(roundTrip({ v: v2 }).v, 2);
	});

	it("RpcV2Event discriminated union survives round-trip for each arm", () => {
		const events: RpcV2Event[] = [
			{
				type: "execution_complete",
				runId: "r1",
				status: "completed",
				stats: {
					sessionFile: undefined,
					sessionId: "s1",
					userMessages: 1,
					assistantMessages: 1,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 2,
					tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
					cost: 0.001,
				},
			},
			{
				type: "cost_update",
				runId: "r1",
				turnCost: 0.001,
				cumulativeCost: 0.001,
				tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			},
		];

		for (const evt of events) {
			const parsed = roundTrip(evt);
			assert.equal(parsed.type, evt.type, "discriminator must round-trip");
			if (parsed.type === "execution_complete" && evt.type === "execution_complete") {
				// `sessionFile: undefined` is dropped by JSON.stringify by design;
				// compare the remaining observable fields.
				assert.equal(parsed.runId, evt.runId);
				assert.equal(parsed.status, evt.status);
				assert.deepEqual(parsed.stats.tokens, evt.stats.tokens);
			}
			if (parsed.type === "cost_update" && evt.type === "cost_update") {
				assert.deepEqual(parsed, evt);
			}
		}
	});
});

// ============================================================================
// RpcClient Construction Tests
// ============================================================================

describe("RpcClient construction", () => {
	it("creates with default options", () => {
		const client = new RpcClient();
		assert.ok(client);
	});

	it("creates with custom options", () => {
		const client = new RpcClient({
			cliPath: "/usr/local/bin/gsd",
			cwd: "/tmp",
			env: { NODE_ENV: "test" },
			provider: "anthropic",
			model: "claude-sonnet",
			args: ["--verbose"],
		});
		assert.ok(client);
	});
});

// ============================================================================
// events() Generator Tests
// ============================================================================

describe("events() async generator", () => {
	it("yields events from a mock stream in order", async () => {
		const client = new RpcClient();

		// Reach into the client to set up a mock process with a PassThrough stdout
		const mockStdout = new PassThrough();
		const mockStderr = new PassThrough();
		const mockStdin = new PassThrough();

		// Simulate a started process by setting internal state
		// We use Object.assign to set private fields for testing
		const clientAny = client as any;
		clientAny.process = {
			stdout: mockStdout,
			stderr: mockStderr,
			stdin: mockStdin,
			exitCode: null,
			kill: () => {},
			on: (event: string, handler: (...args: any[]) => void) => {
				if (event === "exit") {
					// Store exit handler so we can trigger it
					clientAny._testExitHandler = handler;
				}
			},
			removeListener: () => {},
		};

		// Attach the JSONL reader like start() does
		clientAny.stopReadingStdout = attachJsonlLineReader(mockStdout, (line: string) => {
			clientAny.handleLine(line);
		});

		// Collect events from the generator
		const received: SdkAgentEvent[] = [];
		const genPromise = (async () => {
			for await (const event of client.events()) {
				received.push(event);
				if (event.type === "done") break;
			}
		})();

		// Drive the mock stream. The PassThrough pipeline delivers 'data'
		// synchronously off the write; yielding one macrotask between writes
		// lets the generator's awaiting promise resolve before we queue the
		// next event, preserving the observable ordering.
		mockStdout.write(serializeJsonLine({ type: "agent_start", runId: "r1" }));
		await flushIO();
		mockStdout.write(serializeJsonLine({ type: "token", text: "hello" }));
		await flushIO();
		mockStdout.write(serializeJsonLine({ type: "done" }));

		await genPromise;

		assert.equal(received.length, 3);
		assert.equal(received[0].type, "agent_start");
		assert.equal(received[1].type, "token");
		assert.equal(received[2].type, "done");
	});

	it("terminates when process exits", async () => {
		const client = new RpcClient();
		const mockStdout = new PassThrough();
		const mockStderr = new PassThrough();
		const mockStdin = new PassThrough();

		const exitHandlers: Array<() => void> = [];
		const clientAny = client as any;
		clientAny.process = {
			stdout: mockStdout,
			stderr: mockStderr,
			stdin: mockStdin,
			exitCode: null,
			kill: () => {},
			on: (event: string, handler: () => void) => {
				if (event === "exit") exitHandlers.push(handler);
			},
			removeListener: (event: string, handler: () => void) => {
				const idx = exitHandlers.indexOf(handler);
				if (idx !== -1) exitHandlers.splice(idx, 1);
			},
		};

		clientAny.stopReadingStdout = attachJsonlLineReader(mockStdout, (line: string) => {
			clientAny.handleLine(line);
		});

		const received: SdkAgentEvent[] = [];
		const genPromise = (async () => {
			for await (const event of client.events()) {
				received.push(event);
			}
		})();

		// Send one event, let it propagate, then simulate process exit.
		mockStdout.write(serializeJsonLine({ type: "agent_start" }));
		await flushIO();

		// Fire exit handlers
		for (const h of exitHandlers) h();

		await genPromise;

		assert.equal(received.length, 1);
		assert.equal(received[0].type, "agent_start");
	});

	it("throws if client not started", async () => {
		const client = new RpcClient();
		await assert.rejects(async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _event of client.events()) {
				// should not reach
			}
		}, /Client not started/);
	});
});

// ============================================================================
// sendUIResponse Serialization Test
// ============================================================================

describe("sendUIResponse serialization", () => {
	it("writes correct JSONL to stdin", () => {
		const client = new RpcClient();
		const chunks: string[] = [];
		const mockStdin = {
			write: (data: string) => {
				chunks.push(data);
				return true;
			},
		};

		const clientAny = client as any;
		clientAny.process = { stdin: mockStdin };

		client.sendUIResponse("ui_1", { value: "hello" });

		assert.equal(chunks.length, 1);
		const parsed = JSON.parse(chunks[0].trim());
		assert.equal(parsed.type, "extension_ui_response");
		assert.equal(parsed.id, "ui_1");
		assert.equal(parsed.value, "hello");
	});

	it("serializes confirmed response", () => {
		const client = new RpcClient();
		const chunks: string[] = [];
		const mockStdin = {
			write: (data: string) => {
				chunks.push(data);
				return true;
			},
		};
		const clientAny = client as any;
		clientAny.process = { stdin: mockStdin };

		client.sendUIResponse("ui_2", { confirmed: true });

		const parsed = JSON.parse(chunks[0].trim());
		assert.equal(parsed.confirmed, true);
		assert.equal(parsed.id, "ui_2");
	});

	it("serializes cancelled response", () => {
		const client = new RpcClient();
		const chunks: string[] = [];
		const mockStdin = {
			write: (data: string) => {
				chunks.push(data);
				return true;
			},
		};
		const clientAny = client as any;
		clientAny.process = { stdin: mockStdin };

		client.sendUIResponse("ui_3", { cancelled: true });

		const parsed = JSON.parse(chunks[0].trim());
		assert.equal(parsed.cancelled, true);
	});
});

// ============================================================================
// init/shutdown/subscribe Serialization Tests
// ============================================================================

describe("v2 command serialization", () => {
	// Helper: capture what the client sends to stdin
	function createMockClient(): { client: RpcClient; sent: any[]; respondNext: (data?: any) => void } {
		const client = new RpcClient();
		const sent: any[] = [];
		let respondFn: ((data: any) => void) | null = null;

		const clientAny = client as any;
		clientAny.process = {
			stdin: {
				write: (data: string) => {
					const parsed = JSON.parse(data.trim());
					sent.push(parsed);
					// Auto-respond on the microtask queue. This is deterministic —
					// any `await` in the caller yields before the callback runs,
					// so the caller's `pendingRequests` entry is installed before
					// `handleLine` tries to resolve it.
					if (respondFn) {
						queueMicrotask(() => respondFn!(parsed));
					}
					return true;
				},
			},
			stderr: new PassThrough(),
			exitCode: null,
			kill: () => {},
			on: () => {},
			removeListener: () => {},
		};

		const respondNext = (overrides: any = {}) => {
			respondFn = (parsed) => {
				const response = {
					type: "response",
					id: parsed.id,
					command: parsed.type,
					success: true,
					data: {},
					...overrides,
				};
				clientAny.handleLine(JSON.stringify(response));
			};
		};

		return { client, sent, respondNext };
	}

	it("init sends correct v2 init command", async () => {
		const { client, sent, respondNext } = createMockClient();
		respondNext({ data: { protocolVersion: 2, sessionId: "s1", capabilities: { events: [], commands: [] } } });

		const result = await client.init({ clientId: "test-app" });

		assert.equal(sent.length, 1);
		assert.equal(sent[0].type, "init");
		assert.equal(sent[0].protocolVersion, 2);
		assert.equal(sent[0].clientId, "test-app");
		assert.equal(result.protocolVersion, 2);
		assert.equal(result.sessionId, "s1");
	});

	it("shutdown sends shutdown command", async () => {
		const { client, sent, respondNext } = createMockClient();

		// Override the process exit wait
		const clientAny = client as any;
		const originalProcess = clientAny.process;
		const exitHandlers: Array<(code: number) => void> = [];
		clientAny.process = {
			...originalProcess,
			on: (event: string, handler: (code: number) => void) => {
				if (event === "exit") exitHandlers.push(handler);
			},
		};

		respondNext();

		// Call shutdown and simulate process exit. `flushIO` drains the
		// queued stdin write -> auto-respond -> handleLine chain that our
		// mock triggers on every `send`, so by the time we fire the exit
		// handlers the shutdown ack has been observed.
		const shutdownPromise = client.shutdown();
		await flushIO();
		await flushIO();
		for (const h of exitHandlers) h(0);

		await shutdownPromise;

		assert.equal(sent.length, 1);
		assert.equal(sent[0].type, "shutdown");
	});

	it("subscribe sends subscribe command with event list", async () => {
		const { client, sent, respondNext } = createMockClient();
		respondNext();

		await client.subscribe(["execution_complete", "cost_update"]);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].type, "subscribe");
		assert.deepEqual(sent[0].events, ["execution_complete", "cost_update"]);
	});

	it("subscribe with wildcard", async () => {
		const { client, sent, respondNext } = createMockClient();
		respondNext();

		await client.subscribe(["*"]);

		assert.equal(sent[0].events.length, 1);
		assert.equal(sent[0].events[0], "*");
	});
});
