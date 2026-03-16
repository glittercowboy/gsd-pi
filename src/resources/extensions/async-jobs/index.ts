/**
 * Async Jobs Extension
 *
 * Allows bash commands to run in the background. The agent gets a job ID
 * immediately and can continue working. Results are delivered via follow-up
 * messages when jobs complete.
 *
 * Tools:
 *   async_bash — run a command in the background, get a job ID
 *   await_job  — wait for background jobs to complete, get results
 *   cancel_job — cancel a running background job
 *
 * Commands:
 *   /jobs — show running and recent background jobs
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AsyncJobManager, type Job } from "./job-manager.js";
import { createAsyncBashTool } from "./async-bash-tool.js";
import { createAwaitTool } from "./await-tool.js";
import { createCancelJobTool } from "./cancel-job-tool.js";

export default function AsyncJobs(pi: ExtensionAPI) {
	let manager: AsyncJobManager | null = null;
	let latestCwd: string = process.cwd();

	function getManager(): AsyncJobManager {
		if (!manager) {
			throw new Error("AsyncJobManager not initialized. Wait for session_start.");
		}
		return manager;
	}

	function getCwd(): string {
		return latestCwd;
	}

	// ── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCwd = ctx.cwd;

		manager = new AsyncJobManager({
			onJobComplete: (job) => {
				const statusEmoji = job.status === "completed" ? "done" : "error";
				const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
				const output = job.status === "completed"
					? job.resultText ?? "(no output)"
					: `Error: ${job.errorText ?? "unknown error"}`;

				// Truncate output for the follow-up message
				const maxLen = 2000;
				const truncatedOutput = output.length > maxLen
					? output.slice(0, maxLen) + "\n\n[... truncated, use await_job for full output]"
					: output;

				pi.sendMessage(
					{
						customType: "async_job_result",
						content: [
							`**Background job ${statusEmoji}: ${job.id}** (${job.label}, ${elapsed}s)`,
							"",
							truncatedOutput,
						].join("\n"),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		});
	});

	pi.on("session_shutdown", async () => {
		if (manager) {
			manager.shutdown();
			manager = null;
		}
	});

	// ── Tools ──────────────────────────────────────────────────────────────

	pi.registerTool(createAsyncBashTool(getManager, getCwd));
	pi.registerTool(createAwaitTool(getManager));
	pi.registerTool(createCancelJobTool(getManager));

	// ── /jobs command ──────────────────────────────────────────────────────

	pi.registerCommand("jobs", {
		description: "Show running and recent background jobs",
		handler: async (_args: string, _ctx: ExtensionCommandContext) => {
			if (!manager) {
				pi.sendMessage({
					customType: "async_jobs_list",
					content: "No async job manager active.",
					display: true,
				});
				return;
			}

			const running = manager.getRunningJobs();
			const recent = manager.getRecentJobs(10);
			const completed = recent.filter((j) => j.status !== "running");

			const lines: string[] = ["## Background Jobs"];

			if (running.length === 0 && completed.length === 0) {
				lines.push("", "No background jobs.");
			} else {
				if (running.length > 0) {
					lines.push("", "### Running");
					for (const job of running) {
						const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(0);
						lines.push(`- **${job.id}** — ${job.label} (${elapsed}s)`);
					}
				}

				if (completed.length > 0) {
					lines.push("", "### Recent");
					for (const job of completed) {
						const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
						lines.push(`- **${job.id}** — ${job.label} (${job.status}, ${elapsed}s)`);
					}
				}
			}

			pi.sendMessage({
				customType: "async_jobs_list",
				content: lines.join("\n"),
				display: true,
			});
		},
	});
}
