/**
 * await-tool.test.ts — Tests for await_job timeout behavior.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AsyncJobManager } from "./job-manager.ts";
import { createAwaitTool } from "./await-tool.ts";

function getTextFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

const noopSignal = new AbortController().signal;

test("await_job returns immediately when no running jobs exist", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	const result = await tool.execute("tc1", {}, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /No running background jobs/);
});

test("await_job returns immediately when all watched jobs are already completed", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that completes instantly
	const jobId = manager.register("bash", "fast-job", async () => "done");
	// Wait for the job to settle
	const job = manager.getJob(jobId)!;
	await job.promise;

	const result = await tool.execute("tc2", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /fast-job/);
	assert.match(text, /completed/);
});

test("await_job returns on timeout when jobs are still running", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that takes a long time
	const jobId = manager.register("bash", "slow-job", async (_signal) => {
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("finally done"), 60_000);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
		});
	});

	const start = Date.now();
	const result = await tool.execute("tc3", { jobs: [jobId], timeout: 1 }, noopSignal, () => {}, undefined as never);
	const elapsed = Date.now() - start;
	const text = getTextFromResult(result);

	// Should have timed out within ~1-2 seconds, not 60
	assert.ok(elapsed < 5_000, `Expected timeout in ~1s but took ${elapsed}ms`);
	assert.match(text, /Timed out/);
	assert.match(text, /Still running/);
	assert.match(text, /slow-job/);

	// Cleanup
	manager.cancel(jobId);
	manager.shutdown();
});

test("await_job completes before timeout when job finishes quickly", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that completes in 100ms
	const jobId = manager.register("bash", "quick-job", async () => {
		return new Promise<string>((resolve) => setTimeout(() => resolve("quick result"), 100));
	});

	const start = Date.now();
	const result = await tool.execute("tc4", { jobs: [jobId], timeout: 30 }, noopSignal, () => {}, undefined as never);
	const elapsed = Date.now() - start;
	const text = getTextFromResult(result);

	// Should complete in ~100ms, well before the 30s timeout
	assert.ok(elapsed < 5_000, `Expected quick completion but took ${elapsed}ms`);
	assert.ok(!text.includes("Timed out"), "Should not have timed out");
	assert.match(text, /quick-job/);
	assert.match(text, /completed/);

	manager.shutdown();
});

test("await_job uses default timeout of 120s when not specified", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that completes immediately
	const jobId = manager.register("bash", "instant-job", async () => "instant");
	const job = manager.getJob(jobId)!;
	await job.promise;

	// Call without timeout param — should work fine for already-done jobs
	const result = await tool.execute("tc5", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /instant-job/);
	assert.match(text, /completed/);

	manager.shutdown();
});

test("await_job returns not-found message for invalid job IDs", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	const result = await tool.execute("tc6", { jobs: ["bg_nonexistent"] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /No jobs found/);
	assert.match(text, /bg_nonexistent/);

	manager.shutdown();
});

test("await_job suppresses follow-up for jobs that complete while awaiting (#2248)", async () => {
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => followUps.push(job.id),
	});
	const tool = createAwaitTool(() => manager);

	// Register a job that completes in 50ms
	const jobId = manager.register("bash", "awaited-job", async () => {
		return new Promise<string>((resolve) => setTimeout(() => resolve("result"), 50));
	});

	// await_job consumes the result — suppressFollowUp() should cancel delivery timer
	await tool.execute("tc7", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);

	// Give the onJobComplete callback a tick to fire (if suppression failed)
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(followUps.length, 0, "onJobComplete should not fire for jobs consumed by await_job");

	manager.shutdown();
});

test("await_job suppresses follow-up for already-completed jobs (cross-turn case) (#3787)", async () => {
	// This is the key regression: job completes in a prior LLM turn, then
	// await_job is called in a later turn. The delivery timer must still be
	// cancellable at that point.
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => followUps.push(job.id),
	});
	const tool = createAwaitTool(() => manager);

	// Register and let the job complete fully before calling await_job
	const jobId = manager.register("bash", "pre-completed-job", async () => "done");
	const job = manager.getJob(jobId)!;
	await job.promise;

	// Simulate a "later turn" by yielding to the event loop — this lets any
	// queueMicrotask callbacks run, but the setTimeout(0) delivery timer has
	// not yet fired (it's scheduled for the next macrotask).
	await new Promise((r) => setImmediate(r));

	// Now call await_job — suppressFollowUp() should cancel the pending timer
	await tool.execute("tc7b", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);

	// Drain the macrotask queue — the (now-cancelled) timer would have fired here
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(
		followUps.length,
		0,
		"onJobComplete should not fire for already-completed jobs consumed by await_job",
	);

	manager.shutdown();
});

test("unawaited jobs still get follow-up delivery (#2248)", async () => {
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => {
			if (!job.awaited) followUps.push(job.id);
		},
	});

	// Register a fire-and-forget job
	const jobId = manager.register("bash", "fire-and-forget", async () => "done");
	const job = manager.getJob(jobId)!;
	await job.promise;

	// Give the callback a tick
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(followUps.length, 1, "onJobComplete should deliver follow-up for unawaited jobs");
	assert.equal(followUps[0], jobId);

	manager.shutdown();
});
