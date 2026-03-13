/**
 * cancel_job tool — cancel a running background job.
 */

import type { ToolDefinition } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AsyncJobManager } from "./job-manager.js";

const schema = Type.Object({
	job_id: Type.String({ description: "The background job ID to cancel (e.g. bg_a1b2c3d4)" }),
});

export function createCancelJobTool(getManager: () => AsyncJobManager): ToolDefinition<typeof schema> {
	return {
		name: "cancel_job",
		label: "Cancel Background Job",
		description: "Cancel a running background job by its ID.",
		parameters: schema,
		async execute(_toolCallId, params) {
			const manager = getManager();
			const result = manager.cancel(params.job_id);

			const messages: Record<string, string> = {
				cancelled: `Job ${params.job_id} has been cancelled.`,
				not_found: `Job ${params.job_id} not found.`,
				already_completed: `Job ${params.job_id} has already completed (or failed/cancelled).`,
			};

			return {
				content: [{ type: "text", text: messages[result] ?? `Unknown result: ${result}` }],
			};
		},
	};
}
