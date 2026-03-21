/**
 * await_job tool — wait for one or more background jobs to complete.
 *
 * If specific job IDs are provided, waits for those jobs.
 * If omitted, waits for any running job to complete.
 */

import type { ToolDefinition } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AsyncJobManager, Job } from "./job-manager.js";

const DEFAULT_TIMEOUT_SECONDS = 120;

const schema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Job IDs to wait for. Omit to wait for any running job.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Maximum seconds to wait before returning control. Defaults to 120. " +
				"Jobs continue running in the background after timeout.",
		}),
	),
});

export function createAwaitTool(getManager: () => AsyncJobManager): ToolDefinition<typeof schema> {
	return {
		name: "await_job",
		label: "Await Background Job",
		description:
			"Wait for background jobs to complete. Provide specific job IDs or omit to wait for the next job that finishes. Returns results of completed jobs.",
		parameters: schema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const manager = getManager();
			const { jobs: jobIds, timeout } = params;
			const timeoutMs = ((timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000);

			let watched: Job[];
			if (jobIds && jobIds.length > 0) {
				watched = [];
				const notFound: string[] = [];
				for (const id of jobIds) {
					const job = manager.getJob(id);
					if (job) {
						watched.push(job);
					} else {
						notFound.push(id);
					}
				}
				if (notFound.length > 0 && watched.length === 0) {
					return {
						content: [{ type: "text", text: `No jobs found: ${notFound.join(", ")}` }],
						details: undefined,
					};
				}
			} else {
				watched = manager.getRunningJobs();
				if (watched.length === 0) {
					return {
						content: [{ type: "text", text: "No running background jobs." }],
						details: undefined,
					};
				}
			}

			// If all watched jobs are already done, return immediately
			const running = watched.filter((j) => j.status === "running");
			if (running.length === 0) {
				const result = formatResults(watched);
				return { content: [{ type: "text", text: result }], details: undefined };
			}

			// Wait for at least one to complete, or timeout
			const TIMEOUT_SENTINEL = Symbol("timeout");
			const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
				const timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
				// Allow the process to exit even if the timer is pending
				if (typeof timer === "object" && "unref" in timer) timer.unref();
			});

			const raceResult = await Promise.race([
				Promise.race(running.map((j) => j.promise)).then(() => "completed" as const),
				timeoutPromise,
			]);

			const timedOut = raceResult === TIMEOUT_SENTINEL;

			// Collect all completed results (more may have finished while waiting)
			const completed = watched.filter((j) => j.status !== "running");

			const stillRunning = watched.filter((j) => j.status === "running");
			let result = formatResults(completed);
			if (stillRunning.length > 0) {
				result += `\n\n**Still running:** ${stillRunning.map((j) => `${j.id} (${j.label})`).join(", ")}`;
			}
			if (timedOut) {
				result += `\n\n⏱ **Timed out** after ${timeout ?? DEFAULT_TIMEOUT_SECONDS}s waiting for jobs to finish. ` +
					`Jobs are still running in the background. ` +
					`Use \`await_job\` again later or \`async_bash\` + \`await_job\` for shorter polling intervals.`;
			}

			return { content: [{ type: "text", text: result }], details: undefined };
		},
	};
}

function formatResults(jobs: Job[]): string {
	if (jobs.length === 0) return "No completed jobs.";

	const parts: string[] = [];
	for (const job of jobs) {
		const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
		const header = `### ${job.id} — ${job.label} (${job.status}, ${elapsed}s)`;

		if (job.status === "completed") {
			parts.push(`${header}\n\n${job.resultText ?? "(no output)"}`);
		} else if (job.status === "failed") {
			parts.push(`${header}\n\nError: ${job.errorText ?? "unknown error"}`);
		} else if (job.status === "cancelled") {
			parts.push(`${header}\n\nCancelled.`);
		}
	}

	return parts.join("\n\n---\n\n");
}
