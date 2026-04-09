/**
 * async-bash-timeout.test.ts — Tests for async_bash timeout behavior.
 *
 * Reproduces issue #2186: when an async bash job exceeds its timeout and
 * the child process ignores SIGTERM, the promise hangs indefinitely.
 * The fix adds a SIGKILL fallback and a hard deadline that force-resolves
 * the promise so execution can continue.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createAsyncBashTool } from "./async-bash-tool.ts";
import { AsyncJobManager } from "./job-manager.ts";

function getTextFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

const noopSignal = new AbortController().signal;

test("async_bash with timeout resolves even if process ignores SIGTERM", async () => {
	const manager = new AsyncJobManager();
	const tool = createAsyncBashTool(() => manager, () => process.cwd());

	// Start a job that traps SIGTERM (ignores it), with a 2s timeout.
	// The process installs a SIGTERM trap and sleeps for 60s.
	// Before the fix, this would hang forever because SIGTERM is ignored
	// and the close event never fires.
	const result = await tool.execute(
		"tc-timeout",
		{
			command: "trap '' TERM; sleep 60",
			timeout: 2,
			label: "sigterm-resistant",
		},
		noopSignal,
		() => {},
		undefined as never,
	);

	const text = getTextFromResult(result);
	assert.match(text, /sigterm-resistant/);

	const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
	assert.ok(jobId, "Should have returned a job ID");

	// Now await the job — it should resolve within a reasonable time
	// (timeout 2s + SIGKILL grace 5s + buffer = well under 15s)
	const start = Date.now();
	const job = manager.getJob(jobId)!;
	assert.ok(job, "Job should exist");

	await Promise.race([
		job.promise,
		new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error(
				`Job promise hung for ${Date.now() - start}ms — ` +
				`this is the bug from issue #2186: timeout hangs indefinitely`,
			)), 15_000);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);

	const elapsed = Date.now() - start;
	// Should have resolved well within 15s (timeout 2s + kill grace ~5s)
	assert.ok(elapsed < 15_000, `Job took ${elapsed}ms — expected <15s`);

	// Job should have completed (resolved, not rejected) with timeout message
	assert.ok(
		job.status === "completed" || job.status === "failed",
		`Job status should be completed or failed, got: ${job.status}`,
	);

	if (job.status === "completed") {
		assert.ok(
			job.resultText?.includes("timed out") || job.resultText?.includes("Timed out"),
			`Result should mention timeout, got: ${job.resultText}`,
		);
	}

	manager.shutdown();
});

test("async_bash with timeout resolves normally when process exits on SIGTERM", async () => {
	const manager = new AsyncJobManager();
	const tool = createAsyncBashTool(() => manager, () => process.cwd());

	// Start a normal sleep that will die on SIGTERM, with a 1s timeout
	const result = await tool.execute(
		"tc-normal-timeout",
		{
			command: "sleep 60",
			timeout: 1,
			label: "normal-timeout",
		},
		noopSignal,
		() => {},
		undefined as never,
	);

	const text = getTextFromResult(result);
	const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
	assert.ok(jobId, "Should have returned a job ID");

	const job = manager.getJob(jobId)!;
	const start = Date.now();

	await Promise.race([
		job.promise,
		new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error("Job hung")), 10_000);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);

	const elapsed = Date.now() - start;
	assert.ok(elapsed < 5_000, `Expected quick resolution after SIGTERM, took ${elapsed}ms`);
	assert.equal(job.status, "completed");
	assert.ok(job.resultText?.includes("timed out"), `Should mention timeout: ${job.resultText}`);

	manager.shutdown();
});
