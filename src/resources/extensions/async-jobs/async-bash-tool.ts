/**
 * async_bash tool — run a bash command in the background.
 *
 * Registers the command with the AsyncJobManager and returns a job ID
 * immediately. The LLM can continue working and check results later
 * with await_job.
 */

import type { ToolDefinition } from "@gsd/pi-coding-agent";
import {
	getShellConfig,
	sanitizeCommand,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AsyncJobManager } from "./job-manager.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";

const schema = Type.Object({
	command: Type.String({ description: "Bash command to execute in the background" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional)" }),
	),
	label: Type.Optional(
		Type.String({ description: "Short label for the job (shown in /jobs). Defaults to a truncated version of the command." }),
	),
});

function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-async-bash-${id}.log`);
}

/**
 * Kill a process and its children (cross-platform).
 * Uses process group kill on Unix; taskkill /F /T on Windows.
 */
function killTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
				timeout: 5_000,
				stdio: "ignore",
			});
		} catch {
			try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
		}
	} else {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
		}
	}
}

export function createAsyncBashTool(
	getManager: () => AsyncJobManager,
	getCwd: () => string,
): ToolDefinition<typeof schema> {
	return {
		name: "async_bash",
		label: "Background Bash",
		description:
			`Run a bash command in the background. Returns a job ID immediately so you can continue working. ` +
			`Use await_job to get results or cancel_job to stop. Ideal for long-running builds, tests, or installs. ` +
			`Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Run a bash command in the background, returning a job ID immediately.",
		promptGuidelines: [
			"Use async_bash for commands that take more than a few seconds (builds, tests, installs, large git operations).",
			"After starting async jobs, continue with other work and use await_job when you need the results.",
			"await_job has a configurable timeout (default 120s) to prevent indefinite blocking — if it times out, jobs keep running and you can check again later.",
			"For long-running processes (SSH, deploys, training) that may take minutes+, prefer async_bash with periodic await_job polling over a single long await.",
			"Use cancel_job to stop a running background job.",
			"Check /jobs to see all running and recent background jobs.",
		],
		parameters: schema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const manager = getManager();
			const cwd = getCwd();
			const { command, timeout, label } = params;
			const shortCmd = label ?? (command.length > 60 ? command.slice(0, 57) + "..." : command);

			const jobId = manager.register("bash", shortCmd, (signal) => {
				return executeBashInBackground(command, cwd, signal, timeout);
			});

			return {
				content: [{
					type: "text",
					text: [
						`Background job started: **${jobId}**`,
						`Command: \`${shortCmd}\``,
						"",
						"Use `await_job` to get results when ready, or `cancel_job` to stop.",
					].join("\n"),
				}],
				details: undefined,
			};
		},
	};
}

/**
 * Execute a bash command, collecting output. Returns the text result.
 */
function executeBashInBackground(
	command: string,
	cwd: string,
	signal: AbortSignal,
	timeout?: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const safeResolve = (value: string) => { if (!settled) { settled = true; resolve(value); } };
		const safeReject = (err: unknown) => { if (!settled) { settled = true; reject(err); } };

		const { shell, args } = getShellConfig();
		const rewrittenCommand = rewriteCommandWithRtk(command);
		const resolvedCommand = sanitizeCommand(rewrittenCommand);

		// On Windows, detached: true sets CREATE_NEW_PROCESS_GROUP which can
		// cause EINVAL in VSCode/ConPTY terminal contexts.  The bg-shell
		// extension already guards this (process-manager.ts); align here.
		// Process-tree cleanup uses taskkill /F /T on Windows regardless.
		const child = spawn(shell, [...args, resolvedCommand], {
			cwd,
			detached: process.platform !== "win32",
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let timedOut = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let sigkillHandle: ReturnType<typeof setTimeout> | undefined;
		let hardDeadlineHandle: ReturnType<typeof setTimeout> | undefined;

		/** Grace period (ms) between SIGTERM and SIGKILL. */
		const SIGKILL_GRACE_MS = 5_000;
		/** Hard deadline (ms) after SIGKILL to force-resolve the promise. */
		const HARD_DEADLINE_MS = 3_000;

		if (timeout !== undefined && timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killTree(child.pid);

				// If the process ignores SIGTERM, escalate to SIGKILL
				sigkillHandle = setTimeout(() => {
					if (child.pid) {
						// killTree already uses taskkill /F /T on Windows
						killTree(child.pid);
					}

					// Hard deadline: if even SIGKILL doesn't trigger 'close',
					// force-resolve so the job doesn't hang forever (#2186).
					hardDeadlineHandle = setTimeout(() => {
						const output = Buffer.concat(chunks).toString("utf-8");
						safeResolve(
							output
								? `${output}\n\nCommand timed out after ${timeout} seconds (force-killed)`
								: `Command timed out after ${timeout} seconds (force-killed)`,
						);
					}, HARD_DEADLINE_MS);
					if (typeof hardDeadlineHandle === "object" && "unref" in hardDeadlineHandle) hardDeadlineHandle.unref();
				}, SIGKILL_GRACE_MS);
				if (typeof sigkillHandle === "object" && "unref" in sigkillHandle) sigkillHandle.unref();
			}, timeout * 1000);
		}

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let spillFilePath: string | undefined;
		let spillStream: ReturnType<typeof createWriteStream> | undefined;
		const MAX_BUFFER = DEFAULT_MAX_BYTES * 2;

		const onData = (data: Buffer) => {
			totalBytes += data.length;

			if (totalBytes > DEFAULT_MAX_BYTES && !spillFilePath) {
				spillFilePath = getTempFilePath();
				spillStream = createWriteStream(spillFilePath);
				for (const chunk of chunks) spillStream.write(chunk);
			}
			if (spillStream) spillStream.write(data);

			chunks.push(data);
			let chunksBytes = chunks.reduce((s, c) => s + c.length, 0);
			while (chunksBytes > MAX_BUFFER && chunks.length > 1) {
				const removed = chunks.shift()!;
				chunksBytes -= removed.length;
			}
		};

		if (child.stdout) child.stdout.on("data", onData);
		if (child.stderr) child.stderr.on("data", onData);

		const onAbort = () => {
			if (child.pid) killTree(child.pid);
		};

		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (sigkillHandle) clearTimeout(sigkillHandle);
			if (hardDeadlineHandle) clearTimeout(hardDeadlineHandle);
			signal.removeEventListener("abort", onAbort);
			safeReject(err);
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (sigkillHandle) clearTimeout(sigkillHandle);
			if (hardDeadlineHandle) clearTimeout(hardDeadlineHandle);
			signal.removeEventListener("abort", onAbort);
			if (spillStream) spillStream.end();

			if (signal.aborted) {
				const output = Buffer.concat(chunks).toString("utf-8");
				safeResolve(output ? `${output}\n\nCommand aborted` : "Command aborted");
				return;
			}

			if (timedOut) {
				const output = Buffer.concat(chunks).toString("utf-8");
				safeResolve(output ? `${output}\n\nCommand timed out after ${timeout} seconds` : `Command timed out after ${timeout} seconds`);
				return;
			}

			const fullOutput = Buffer.concat(chunks).toString("utf-8");

			const lines = fullOutput.split("\n");
			let text: string;
			if (lines.length > DEFAULT_MAX_LINES) {
				text = lines.slice(-DEFAULT_MAX_LINES).join("\n");
				if (spillFilePath) {
					text += `\n\n[Showing last ${DEFAULT_MAX_LINES} of ${lines.length} lines. Full output: ${spillFilePath}]`;
				} else {
					text += `\n\n[Showing last ${DEFAULT_MAX_LINES} of ${lines.length} lines]`;
				}
			} else {
				text = fullOutput || "(no output)";
			}

			if (code !== 0 && code !== null) {
				text += `\n\nCommand exited with code ${code}`;
			}

			safeResolve(text);
		});
	});
}
