/**
 * await_job tool — wait for one or more background jobs to complete.
 *
 * If specific job IDs are provided, waits for those jobs.
 * If omitted, waits for any running job to complete.
 */

import type { ToolDefinition } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AsyncJobManager, Job } from "./job-manager.js";

const schema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Job IDs to wait for. Omit to wait for any running job.",
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
		async execute(_toolCallId, params) {
			const manager = getManager();
			const { jobs: jobIds } = params;

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
					};
				}
			} else {
				watched = manager.getRunningJobs();
				if (watched.length === 0) {
					return {
						content: [{ type: "text", text: "No running background jobs." }],
					};
				}
			}

			// If all watched jobs are already done, return immediately
			const running = watched.filter((j) => j.status === "running");
			if (running.length === 0) {
				const result = formatResults(watched);
				manager.acknowledgeDeliveries(watched.map((j) => j.id));
				return { content: [{ type: "text", text: result }] };
			}

			// Wait for at least one to complete
			await Promise.race(running.map((j) => j.promise));

			// Collect all completed results (more may have finished while waiting)
			const completed = watched.filter((j) => j.status !== "running");
			manager.acknowledgeDeliveries(completed.map((j) => j.id));

			const stillRunning = watched.filter((j) => j.status === "running");
			let result = formatResults(completed);
			if (stillRunning.length > 0) {
				result += `\n\n**Still running:** ${stillRunning.map((j) => `${j.id} (${j.label})`).join(", ")}`;
			}

			return { content: [{ type: "text", text: result }] };
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
