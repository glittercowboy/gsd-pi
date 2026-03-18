import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentTelemetry } from "../agent-telemetry.js";
import type { AgentInvocation } from "../agent-telemetry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpStore(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-telemetry-test-"));
	return path.join(dir, "telemetry.jsonl");
}

function makeInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
	return {
		agentName: "scout",
		timestamp: new Date().toISOString(),
		taskSummary: "test task",
		success: true,
		turns: 10,
		inputTokens: 1000,
		outputTokens: 500,
		cost: 0.05,
		durationMs: 5000,
		...overrides,
	};
}

// ─── record and getHistory ──────────────────────────────────────────────────

test("record writes to JSONL and getHistory reads it back", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	const inv = makeInvocation();
	telemetry.record(inv);

	const history = telemetry.getHistory("scout");
	assert.equal(history.length, 1);
	assert.equal(history[0].agentName, "scout");
	assert.equal(history[0].taskSummary, "test task");
});

test("getHistory returns entries sorted by timestamp descending", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	telemetry.record(makeInvocation({ timestamp: "2025-01-01T00:00:00Z", taskSummary: "first" }));
	telemetry.record(makeInvocation({ timestamp: "2025-01-03T00:00:00Z", taskSummary: "third" }));
	telemetry.record(makeInvocation({ timestamp: "2025-01-02T00:00:00Z", taskSummary: "second" }));

	const history = telemetry.getHistory("scout");
	assert.equal(history[0].taskSummary, "third");
	assert.equal(history[1].taskSummary, "second");
	assert.equal(history[2].taskSummary, "first");
});

test("getHistory respects limit parameter", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	for (let i = 0; i < 5; i++) {
		telemetry.record(makeInvocation({ timestamp: `2025-01-0${i + 1}T00:00:00Z` }));
	}

	const history = telemetry.getHistory("scout", 2);
	assert.equal(history.length, 2);
});

test("getHistory filters by agent name", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	telemetry.record(makeInvocation({ agentName: "scout" }));
	telemetry.record(makeInvocation({ agentName: "worker" }));
	telemetry.record(makeInvocation({ agentName: "scout" }));

	assert.equal(telemetry.getHistory("scout").length, 2);
	assert.equal(telemetry.getHistory("worker").length, 1);
});

// ─── getMetrics ─────────────────────────────────────────────────────────────

test("getMetrics returns zero metrics for unknown agent", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	const metrics = telemetry.getMetrics("nonexistent");
	assert.equal(metrics.totalInvocations, 0);
	assert.equal(metrics.successRate, 0);
	assert.equal(metrics.lastUsed, null);
	assert.equal(metrics.trend, "stable");
});

test("getMetrics computes correct averages", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	telemetry.record(makeInvocation({ turns: 10, cost: 0.10, durationMs: 2000, success: true }));
	telemetry.record(makeInvocation({ turns: 20, cost: 0.20, durationMs: 4000, success: false }));

	const metrics = telemetry.getMetrics("scout");
	assert.equal(metrics.totalInvocations, 2);
	assert.equal(metrics.successRate, 0.5);
	assert.equal(metrics.avgTurns, 15);
	assert.ok(Math.abs(metrics.avgCost - 0.15) < 1e-10, `avgCost should be ~0.15, got ${metrics.avgCost}`);
	assert.equal(metrics.avgDurationMs, 3000);
});

test("getMetrics respects windowDays filter", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
	const recent = new Date().toISOString();

	telemetry.record(makeInvocation({ timestamp: old, turns: 100 }));
	telemetry.record(makeInvocation({ timestamp: recent, turns: 10 }));

	const metrics = telemetry.getMetrics("scout", 30);
	assert.equal(metrics.totalInvocations, 1);
	assert.equal(metrics.avgTurns, 10);
});

// ─── getAllMetrics ───────────────────────────────────────────────────────────

test("getAllMetrics returns metrics for all agents", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	telemetry.record(makeInvocation({ agentName: "scout" }));
	telemetry.record(makeInvocation({ agentName: "worker" }));
	telemetry.record(makeInvocation({ agentName: "scout" }));

	const all = telemetry.getAllMetrics();
	assert.equal(all.length, 2);
	const names = all.map((m) => m.agentName).sort();
	assert.deepEqual(names, ["scout", "worker"]);
});

// ─── Trend calculation ──────────────────────────────────────────────────────

test("trend is stable when fewer than 6 invocations", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	for (let i = 0; i < 5; i++) {
		telemetry.record(makeInvocation({ timestamp: `2025-01-0${i + 1}T00:00:00Z` }));
	}

	const metrics = telemetry.getMetrics("scout");
	assert.equal(metrics.trend, "stable");
});

test("trend is improving when recent success rate is higher", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	// Previous 5: all failures
	for (let i = 0; i < 5; i++) {
		telemetry.record(makeInvocation({
			timestamp: `2025-01-0${i + 1}T00:00:00Z`,
			success: false,
		}));
	}
	// Recent 5: all successes
	for (let i = 5; i < 10; i++) {
		telemetry.record(makeInvocation({
			timestamp: `2025-01-${i + 1}T00:00:00Z`,
			success: true,
		}));
	}

	const metrics = telemetry.getMetrics("scout");
	assert.equal(metrics.trend, "improving");
});

test("trend is declining when recent success rate is lower", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	// Previous 5: all successes
	for (let i = 0; i < 5; i++) {
		telemetry.record(makeInvocation({
			timestamp: `2025-01-0${i + 1}T00:00:00Z`,
			success: true,
		}));
	}
	// Recent 5: all failures
	for (let i = 5; i < 10; i++) {
		telemetry.record(makeInvocation({
			timestamp: `2025-01-${i + 1}T00:00:00Z`,
			success: false,
		}));
	}

	const metrics = telemetry.getMetrics("scout");
	assert.equal(metrics.trend, "declining");
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test("handles empty store file gracefully", () => {
	const store = tmpStore();
	const telemetry = new AgentTelemetry(store);

	const history = telemetry.getHistory("scout");
	assert.equal(history.length, 0);
});

test("creates parent directories if they do not exist", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-telemetry-nest-"));
	const store = path.join(dir, "nested", "deep", "telemetry.jsonl");
	const telemetry = new AgentTelemetry(store);

	telemetry.record(makeInvocation());
	assert.ok(fs.existsSync(store));
});
