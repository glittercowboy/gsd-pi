/**
 * Background Shell Extension v2
 *
 * A next-generation background process manager designed for agentic workflows.
 * Provides intelligent process lifecycle management, structured output digests,
 * event-driven readiness detection, and context-efficient communication.
 *
 * Key capabilities:
 * - Multi-tier output: digest (30 tokens) → highlights → raw (full context)
 * - Readiness detection: port probing, pattern matching, auto-classification
 * - Process lifecycle events: starting → ready → error → exited
 * - Output diffing & dedup: detect novel errors vs. repeated noise
 * - Process groups: manage related processes as a unit
 * - Cross-session persistence: survive context resets
 * - Expect-style interactions: send_and_wait for interactive CLIs
 * - Context injection: proactive alerts for crashes and state changes
 *
 * Tools:
 *   bg_shell — start, output, digest, wait_for_ready, send, send_and_wait, run,
 *              signal, list, kill, restart, group_status
 *
 * Commands:
 *   /bg — interactive process manager overlay
 */

import { StringEnum } from "@gsd/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@gsd/pi-coding-agent";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	Key,
} from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { shortcutDesc } from "../shared/terminal.js";

// ── Sub-module imports ─────────────────────────────────────────────────────

import type { BgProcessInfo, ProcessType, ProcessStatus } from "./types.js";
import { DEFAULT_READY_TIMEOUT } from "./types.js";
import {
	processes,
	pendingAlerts,
	startProcess,
	killProcess,
	restartProcess,
	getInfo,
	getGroupStatus,
	pruneDeadProcesses,
	cleanupAll,
	persistManifest,
	loadManifest,
	pushAlert,
} from "./process-manager.js";
import {
	generateDigest,
	getHighlights,
	getOutput,
	formatDigestText,
} from "./output-formatter.js";
import { waitForReady } from "./readiness-detector.js";
import { queryShellEnv, sendAndWait, runOnSession } from "./interaction.js";
import { formatUptime, formatTokenCount } from "./utilities.js";
import { BgManagerOverlay } from "./overlay.js";

// ── Re-exports for consumers ───────────────────────────────────────────────

export type { ProcessStatus, ProcessType, BgProcess, BgProcessInfo, OutputDigest, OutputLine, ProcessEvent } from "./types.js";
export { processes, startProcess, killProcess, restartProcess, cleanupAll } from "./process-manager.js";
export { generateDigest, getHighlights, getOutput, formatDigestText } from "./output-formatter.js";
export { waitForReady, probePort } from "./readiness-detector.js";
export { sendAndWait, runOnSession, queryShellEnv } from "./interaction.js";
export { BgManagerOverlay } from "./overlay.js";

// ── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | null = null;

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		cleanupAll();
	});

	// Register signal handlers to clean up bg processes on unexpected exit (fixes #428)
	// This prevents orphan processes and helps the parent restore terminal state
	const signalCleanup = () => {
		cleanupAll();
	};
	process.on("SIGTERM", signalCleanup);
	process.on("SIGINT", signalCleanup);
	process.on("beforeExit", signalCleanup);

	// ── Compaction Awareness: Survive Context Resets ───────────────

	/** Build a compact state summary of all alive processes for context re-injection */
	function buildProcessStateAlert(reason: string): void {
		const alive = Array.from(processes.values()).filter(p => p.alive);
		if (alive.length === 0) return;

		const processSummaries = alive.map(p => {
			const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
			const urlInfo = p.urls.length > 0 ? ` ${p.urls[0]}` : "";
			const errInfo = p.recentErrors.length > 0 ? ` (${p.recentErrors.length} errors)` : "";
			const groupInfo = p.group ? ` [${p.group}]` : "";
			return `  - id:${p.id} "${p.label}" [${p.processType}] status:${p.status} uptime:${formatUptime(Date.now() - p.startedAt)}${portInfo}${urlInfo}${errInfo}${groupInfo}`;
		}).join("\n");

		pendingAlerts.push(
			`${reason} ${alive.length} background process(es) are still running:\n${processSummaries}\nUse bg_shell digest/output/kill with these IDs.`
		);
	}

	// After compaction, the LLM loses all memory of running processes.
	// Queue a detailed alert so the next before_agent_start injects full state.
	pi.on("session_compact", async () => {
		buildProcessStateAlert("Context was compacted.");
	});

	// Tree navigation also resets the agent's context.
	pi.on("session_tree", async () => {
		buildProcessStateAlert("Session tree was navigated.");
	});

	// Session switch resets the agent's context.
	pi.on("session_switch", async () => {
		buildProcessStateAlert("Session was switched.");
	});

	// ── Context Injection: Proactive Alerts ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Inject process status overview and any pending alerts
		const alerts = pendingAlerts.splice(0);
		const alive = Array.from(processes.values()).filter(p => p.alive);

		if (alerts.length === 0 && alive.length === 0) return;

		const parts: string[] = [];

		if (alerts.length > 0) {
			parts.push(`Background process alerts:\n${alerts.map(a => `  ${a}`).join("\n")}`);
		}

		if (alive.length > 0) {
			const summary = alive.map(p => {
				const status = p.status === "ready" ? "✓" : p.status === "error" ? "✗" : p.status === "starting" ? "⋯" : "?";
				const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
				const errInfo = p.recentErrors.length > 0 ? ` (${p.recentErrors.length} errors)` : "";
				return `  ${status} ${p.id} ${p.label}${portInfo}${errInfo}`;
			}).join("\n");
			parts.push(`Background processes:\n${summary}`);
		}

		return {
			message: {
				customType: "bg-shell-status",
				content: parts.join("\n\n"),
				display: false,
			},
		};
	});

	// ── Session Start: Discover Surviving Processes ────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;

		// Check for surviving processes from previous session
		const manifest = loadManifest(ctx.cwd);
		if (manifest.length > 0) {
			// Check which PIDs are still alive
			const surviving: typeof manifest = [];
			for (const entry of manifest) {
				if (entry.pid) {
					try {
						process.kill(entry.pid, 0); // Check if process exists
						surviving.push(entry);
					} catch { /* process is dead */ }
				}
			}

			if (surviving.length > 0) {
				const summary = surviving.map(s =>
					`  - ${s.id}: ${s.label} (pid ${s.pid}, type: ${s.processType}${s.group ? `, group: ${s.group}` : ""})`
				).join("\n");

				pendingAlerts.push(
					`${surviving.length} background process(es) from previous session still running:\n${summary}\n  Note: These processes are outside bg_shell's control. Kill them manually if needed.`
				);
			}
		}
	});

	// ── Tool ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "bg_shell",
		label: "Background Shell",
		description:
			"Run shell commands in the background without blocking. Manages persistent background processes with intelligent lifecycle tracking. " +
			"Actions: start (launch with auto-classification & readiness detection), digest (structured summary ~30 tokens vs ~2000 raw), " +
			"output (raw lines with incremental delivery), wait_for_ready (block until process signals readiness), " +
			"send (write stdin), send_and_wait (expect-style: send + wait for output pattern), " +
			"run (execute a command on a persistent shell session, block until done, return output + exit code), " +
			"env (query shell cwd and environment variables), " +
			"signal (send OS signal), list (all processes with status), kill (terminate), restart (kill + relaunch), " +
			"group_status (health of a process group), highlights (significant output lines only).",

		promptGuidelines: [
			"Use bg_shell to start long-running processes (servers, watchers, builds) that should not block the agent.",
			"After starting a server, use 'wait_for_ready' to efficiently block until it's listening — avoids polling loops entirely.",
			"Use 'digest' instead of 'output' when you just need status — it returns a structured ~30-token summary instead of ~2000 tokens of raw output.",
			"Use 'highlights' to see only significant output (errors, URLs, results) — typically 5-15 lines instead of hundreds.",
			"Use 'output' only when you need raw lines for debugging — add filter:'error|warning' to narrow results.",
			"The 'output' action returns only new output since the last check (incremental). Repeated calls are cheap on context.",
			"Set type:'server' and ready_port:3000 for dev servers so readiness detection is automatic.",
			"Set group:'my-stack' on related processes to manage them together with 'group_status'.",
			"Use 'run' to execute a command on a persistent shell session and block until it completes — returns structured output + exit code. Shell state (env vars, cwd, virtualenvs) persists across runs.",
			"Use 'send_and_wait' for interactive CLIs: send input and wait for expected output pattern.",
			"Use 'env' to check the current working directory and active environment variables of a shell session — useful after cd, source, or export commands.",
			"Use 'restart' to kill and relaunch with the same config — preserves restart count.",
			"Background processes are auto-classified (server/build/test/watcher) based on the command.",
			"Process crashes and errors are automatically surfaced as alerts at the start of your next turn — you don't need to poll.",
			"To create a persistent shell session: bg_shell start with type:'shell'. The session stays alive for interactive use with 'send', 'send_and_wait', or 'run'.",
		],

		parameters: Type.Object({
			action: StringEnum([
				"start",
				"digest",
				"output",
				"highlights",
				"wait_for_ready",
				"send",
				"send_and_wait",
				"run",
				"env",
				"signal",
				"list",
				"kill",
				"restart",
				"group_status",
			] as const),
			command: Type.Optional(
				Type.String({ description: "Shell command to run (for start, run)" }),
			),
			label: Type.Optional(
				Type.String({ description: "Short human-readable label for the process (for start)" }),
			),
			id: Type.Optional(
				Type.String({ description: "Process ID (for digest, output, highlights, wait_for_ready, send, send_and_wait, run, signal, kill, restart)" }),
			),
			stream: Type.Optional(
				StringEnum(["stdout", "stderr", "both"] as const),
			),
			tail: Type.Optional(
				Type.Number({ description: "Number of most recent lines to return (for output). Defaults to 100." }),
			),
			filter: Type.Optional(
				Type.String({ description: "Regex pattern to filter output lines (for output). Case-insensitive." }),
			),
			input: Type.Optional(
				Type.String({ description: "Text to write to process stdin (for send, send_and_wait)" }),
			),
			wait_pattern: Type.Optional(
				Type.String({ description: "Regex to wait for in output (for send_and_wait)" }),
			),
			signal_name: Type.Optional(
				Type.String({ description: "OS signal to send, e.g. SIGINT, SIGTERM, SIGHUP (for signal)" }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in milliseconds (for wait_for_ready, send_and_wait, run). Default: 30000 for wait_for_ready/send_and_wait, 120000 for run" }),
			),
			type: Type.Optional(
				StringEnum(["server", "build", "test", "watcher", "generic", "shell"] as const),
			),
			ready_pattern: Type.Optional(
				Type.String({ description: "Regex pattern that indicates the process is ready (for start)" }),
			),
			ready_port: Type.Optional(
				Type.Number({ description: "Port to probe for readiness (for start). When open, process is considered ready." }),
			),
			ready_timeout: Type.Optional(
				Type.Number({ description: "Max milliseconds to wait for ready_port/ready_pattern before marking as error (default: 30000)" }),
			),
			group: Type.Optional(
				Type.String({ description: "Group name for related processes (for start, group_status)" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;

			switch (params.action) {
				// ── start ──────────────────────────────────────────
				case "start": {
					if (!params.command) {
						return {
							content: [{ type: "text" as const, text: "Error: 'command' is required for start" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = startProcess({
						command: params.command,
						cwd: ctx.cwd,
						label: params.label,
						type: params.type as ProcessType | undefined,
						readyPattern: params.ready_pattern,
						readyPort: params.ready_port,
						readyTimeout: params.ready_timeout,
						group: params.group,
					});

					// Give the process a moment to potentially fail immediately
					await new Promise(r => setTimeout(r, 500));

					// Persist manifest
					persistManifest(ctx.cwd);

					const info = getInfo(bg);
					let text = `Started background process ${bg.id}\n`;
					text += `  label: ${bg.label}\n`;
					text += `  type: ${bg.processType}\n`;
					text += `  status: ${bg.status}\n`;
					text += `  command: ${bg.command}\n`;
					text += `  cwd: ${bg.cwd}`;

					if (bg.group) text += `\n  group: ${bg.group}`;
					if (bg.readyPort) text += `\n  ready_port: ${bg.readyPort}`;
					if (bg.readyPattern) text += `\n  ready_pattern: ${bg.readyPattern}`;
					if (bg.ports.length > 0) text += `\n  detected ports: ${bg.ports.join(", ")}`;
					if (bg.urls.length > 0) text += `\n  detected urls: ${bg.urls.join(", ")}`;

					if (!bg.alive) {
						text += `\n  exit code: ${bg.exitCode}`;
						const errLines = bg.output.filter(l => l.stream === "stderr").map(l => l.line);
						const errOut = errLines.join("\n").trim();
						if (errOut) text += `\n  stderr:\n${errOut}`;
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "start", process: info },
					};
				}

				// ── digest ─────────────────────────────────────────
				case "digest": {
					// Can get digest for a single process or all
					if (params.id) {
						const bg = processes.get(params.id);
						if (!bg) {
							return {
								content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
								isError: true, details: undefined as unknown,
							};
						}
						const digest = generateDigest(bg, true);
						return {
							content: [{ type: "text" as const, text: formatDigestText(bg, digest) }],
							details: { action: "digest", process: getInfo(bg), digest },
						};
					}

					// All processes digest
					const all = Array.from(processes.values());
					if (all.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No background processes." }],
							details: { action: "digest", processes: [] },
						};
					}

					const lines = all.map(bg => {
						const d = generateDigest(bg, true);
						const status = bg.alive
							? (bg.status === "ready" ? "✓" : bg.status === "error" ? "✗" : "⋯")
							: "○";
						const portInfo = d.ports.length > 0 ? ` :${d.ports.join(",")}` : "";
						const errInfo = d.errors.length > 0 ? ` (${d.errors.length} errors)` : "";
						return `${status} ${bg.id} ${bg.label} [${bg.processType}] ${d.uptime}${portInfo}${errInfo} — ${d.changeSummary}`;
					});

					return {
						content: [{ type: "text" as const, text: `Background processes (${all.length}):\n${lines.join("\n")}` }],
						details: { action: "digest", count: all.length },
					};
				}

				// ── highlights ──────────────────────────────────────
				case "highlights": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for highlights" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					const highlights = getHighlights(bg, params.tail || 15);
					const info = getInfo(bg);
					let text = `Highlights for ${bg.id} (${bg.label}) — ${bg.status}:\n`;
					if (highlights.length === 0) {
						text += "(no significant output)";
					} else {
						text += highlights.join("\n");
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "highlights", process: info, lineCount: highlights.length },
					};
				}

				// ── output ─────────────────────────────────────────
				case "output": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for output" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					const stream = params.stream || "both";
					const tail = params.tail ?? 100;
					const output = getOutput(bg, {
						stream,
						tail,
						filter: params.filter,
						incremental: true,
					});
					const info = getInfo(bg);

					let text = `Process ${bg.id} (${bg.label})`;
					text += ` — ${bg.alive ? `${bg.status}` : `exited (code ${bg.exitCode})`}`;
					if (output) {
						text += `\n${output}`;
					} else {
						text += `\n(no new output since last check)`;
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "output", process: info, stream, tail },
					};
				}

				// ── wait_for_ready ──────────────────────────────────
				case "wait_for_ready": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for wait_for_ready" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					// Already ready?
					if (bg.status === "ready") {
						const digest = generateDigest(bg, true);
						return {
							content: [{ type: "text" as const, text: `Process ${bg.id} is already ready.\n${formatDigestText(bg, digest)}` }],
							details: { action: "wait_for_ready", process: getInfo(bg), ready: true },
						};
					}

					const timeout = params.timeout || DEFAULT_READY_TIMEOUT;
					const result = await waitForReady(bg, timeout, signal ?? undefined);

					const digest = generateDigest(bg, true);
					let text: string;
					if (result.ready) {
						text = `✓ Process ${bg.id} is ready: ${result.detail}\n${formatDigestText(bg, digest)}`;
					} else {
						text = `✗ Process ${bg.id} not ready: ${result.detail}\n${formatDigestText(bg, digest)}`;
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "wait_for_ready", process: getInfo(bg), ready: result.ready, detail: result.detail },
					};
				}

				// ── send ───────────────────────────────────────────
				case "send": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for send" }],
							isError: true, details: undefined as unknown,
						};
					}
					if (params.input === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: 'input' is required for send" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					if (!bg.alive) {
						return {
							content: [{ type: "text" as const, text: `Error: Process ${params.id} has already exited` }],
							isError: true, details: undefined as unknown,
						};
					}

					try {
						bg.proc.stdin?.write(params.input + "\n");
						return {
							content: [{ type: "text" as const, text: `Sent input to process ${bg.id}` }],
							details: { action: "send", process: getInfo(bg) },
						};
					} catch (err) {
						return {
							content: [{ type: "text" as const, text: `Error writing to stdin: ${err instanceof Error ? err.message : String(err)}` }],
							isError: true, details: undefined as unknown,
						};
					}
				}

				// ── send_and_wait ───────────────────────────────────
				case "send_and_wait": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for send_and_wait" }],
							isError: true, details: undefined as unknown,
						};
					}
					if (params.input === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: 'input' is required for send_and_wait" }],
							isError: true, details: undefined as unknown,
						};
					}
					if (!params.wait_pattern) {
						return {
							content: [{ type: "text" as const, text: "Error: 'wait_pattern' is required for send_and_wait" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					if (!bg.alive) {
						return {
							content: [{ type: "text" as const, text: `Error: Process ${params.id} has already exited` }],
							isError: true, details: undefined as unknown,
						};
					}

					const timeout = params.timeout || 10000;
					const result = await sendAndWait(bg, params.input, params.wait_pattern, timeout, signal ?? undefined);

					let text: string;
					if (result.matched) {
						text = `✓ Pattern matched for process ${bg.id}\n${result.output}`;
					} else {
						text = `✗ Pattern not matched (timed out after ${timeout}ms)\n${result.output}`;
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "send_and_wait", process: getInfo(bg), matched: result.matched },
					};
				}

				// ── run ────────────────────────────────────────────
				case "run": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for run" }],
							isError: true, details: undefined as unknown,
						};
					}
					if (!params.command) {
						return {
							content: [{ type: "text" as const, text: "Error: 'command' is required for run" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					if (!bg.alive) {
						return {
							content: [{ type: "text" as const, text: `Error: Process ${params.id} has already exited` }],
							isError: true, details: undefined as unknown,
						};
					}

					const runTimeout = params.timeout || 120000;
					const result = await runOnSession(bg, params.command, runTimeout, signal ?? undefined);

					let text: string;
					if (result.timedOut) {
						text = `Command timed out after ${runTimeout}ms\nOutput:\n${result.output}`;
					} else {
						text = `Exit code: ${result.exitCode}\n${result.output}`;
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "run", process: getInfo(bg), exitCode: result.exitCode, timedOut: result.timedOut },
					};
				}

				// ── env ───────────────────────────────────────────
				case "env": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for env" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					if (!bg.alive) {
						return {
							content: [{ type: "text" as const, text: `Error: Process ${params.id} has already exited` }],
							isError: true, details: undefined as unknown,
						};
					}

					const timeout = params.timeout || 5000;
					const envResult = await queryShellEnv(bg, timeout, signal ?? undefined);

					if (!envResult) {
						return {
							content: [{ type: "text" as const, text: `Failed to query environment for process ${bg.id} (timed out or process died)` }],
							isError: true, details: undefined as unknown,
						};
					}

					let text = `Shell environment for ${bg.id} (${bg.label}):\n`;
					text += `  cwd: ${envResult.cwd}\n`;
					text += `  shell: ${envResult.shell}\n`;

					const envEntries = Object.entries(envResult.env);
					if (envEntries.length > 0) {
						text += `  environment:\n`;
						for (const [key, value] of envEntries) {
							const displayValue = value.length > 100 ? value.slice(0, 97) + "..." : value;
							text += `    ${key}=${displayValue}\n`;
						}
					}

					return {
						content: [{ type: "text" as const, text: text.trimEnd() }],
						details: { action: "env", process: getInfo(bg), env: envResult },
					};
				}

				// ── signal ─────────────────────────────────────────
				case "signal": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for signal" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					const sig = (params.signal_name || "SIGINT") as NodeJS.Signals;
					const sent = killProcess(params.id, sig);

					return {
						content: [{ type: "text" as const, text: sent ? `Sent ${sig} to process ${bg.id} (${bg.label})` : `Failed to send ${sig} to process ${bg.id}` }],
						details: { action: "signal", process: getInfo(bg), signal: sig },
					};
				}

				// ── list ───────────────────────────────────────────
				case "list": {
					const all = Array.from(processes.values()).map(getInfo);

					if (all.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No background processes." }],
							details: { action: "list", processes: [] },
						};
					}

					const lines = all.map(p => {
						const status = p.alive
							? (p.status === "ready" ? "✓ ready" : p.status === "error" ? "✗ error" : "⋯ starting")
							: `○ ${p.status} (code ${p.exitCode})`;
						const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
						const urlInfo = p.urls.length > 0 ? ` ${p.urls[0]}` : "";
						const groupInfo = p.group ? ` [${p.group}]` : "";
						return `${p.id}  ${status}  ${p.uptime}  ${p.label}  [${p.processType}]${portInfo}${urlInfo}${groupInfo}`;
					});

					return {
						content: [{ type: "text" as const, text: `Background processes (${all.length}):\n${lines.join("\n")}` }],
						details: { action: "list", processes: all },
					};
				}

				// ── kill ───────────────────────────────────────────
				case "kill": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for kill" }],
							isError: true, details: undefined as unknown,
						};
					}

					const bg = processes.get(params.id);
					if (!bg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					const killed = killProcess(params.id, "SIGTERM");
					await new Promise(r => setTimeout(r, 300));
					if (bg.alive) {
						killProcess(params.id, "SIGKILL");
						await new Promise(r => setTimeout(r, 200));
					}

					const info = getInfo(bg);
					if (!bg.alive) processes.delete(params.id);

					// Update manifest
					persistManifest(ctx.cwd);

					return {
						content: [{ type: "text" as const, text: killed ? `Killed process ${bg.id} (${bg.label})` : `Failed to kill process ${bg.id}` }],
						details: { action: "kill", process: info },
					};
				}

				// ── restart ────────────────────────────────────────
				case "restart": {
					if (!params.id) {
						return {
							content: [{ type: "text" as const, text: "Error: 'id' is required for restart" }],
							isError: true, details: undefined as unknown,
						};
					}

					const newBg = await restartProcess(params.id);
					if (!newBg) {
						return {
							content: [{ type: "text" as const, text: `Error: No process found with id '${params.id}'` }],
							isError: true, details: undefined as unknown,
						};
					}

					// Give it a moment
					await new Promise(r => setTimeout(r, 500));
					persistManifest(ctx.cwd);

					const info = getInfo(newBg);
					let text = `Restarted process (restart #${newBg.restartCount})\n`;
					text += `  new id: ${newBg.id}\n`;
					text += `  label: ${newBg.label}\n`;
					text += `  type: ${newBg.processType}\n`;
					text += `  status: ${newBg.status}\n`;
					text += `  command: ${newBg.command}`;

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "restart", process: info, previousId: params.id },
					};
				}

				// ── group_status ────────────────────────────────────
				case "group_status": {
					if (!params.group) {
						// List all groups
						const groups = new Set<string>();
						for (const p of processes.values()) {
							if (p.group) groups.add(p.group);
						}

						if (groups.size === 0) {
							return {
								content: [{ type: "text" as const, text: "No process groups defined." }],
								details: { action: "group_status", groups: [] },
							};
						}

						const statuses = Array.from(groups).map(g => {
							const gs = getGroupStatus(g);
							const icon = gs.healthy ? "✓" : "✗";
							const procs = gs.processes.map(p => `${p.id} (${p.status})`).join(", ");
							return `${icon} ${g}: ${procs}`;
						});

						return {
							content: [{ type: "text" as const, text: `Process groups:\n${statuses.join("\n")}` }],
							details: { action: "group_status", groups: Array.from(groups) },
						};
					}

					const gs = getGroupStatus(params.group);
					const icon = gs.healthy ? "✓" : "✗";
					let text = `${icon} Group '${params.group}' — ${gs.healthy ? "healthy" : "unhealthy"}\n`;
					for (const p of gs.processes) {
						text += `  ${p.id}: ${p.label} — ${p.status}${p.alive ? "" : " (dead)"}\n`;
					}

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "group_status", groupStatus: gs },
					};
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						isError: true, details: undefined as unknown,
					};
			}
		},

		// ── Rendering ────────────────────────────────────────────────────

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("bg_shell "));
			text += theme.fg("accent", args.action);
			if (args.command) text += " " + theme.fg("muted", `$ ${args.command}`);
			if (args.id) text += " " + theme.fg("dim", `[${args.id}]`);
			if (args.label) text += " " + theme.fg("dim", `(${args.label})`);
			if (args.type) text += " " + theme.fg("dim", `type:${args.type}`);
			if (args.ready_port) text += " " + theme.fg("dim", `port:${args.ready_port}`);
			if (args.group) text += " " + theme.fg("dim", `group:${args.group}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const action = details.action as string;

			if ((result as any).isError) {
				const text = result.content[0];
				return new Text(
					theme.fg("error", text?.type === "text" ? text.text : "Error"),
					0, 0,
				);
			}

			switch (action) {
				case "start": {
					const proc = details.process as BgProcessInfo;
					let text = theme.fg("success", "▸ Started ");
					text += theme.fg("accent", proc.id);
					text += " " + theme.fg("muted", proc.label);
					text += " " + theme.fg("dim", `[${proc.processType}]`);
					if (proc.ports.length > 0) text += " " + theme.fg("dim", `:${proc.ports.join(",")}`);
					if (!proc.alive) {
						text += " " + theme.fg("error", `(exited: ${proc.exitCode})`);
					}
					return new Text(text, 0, 0);
				}

				case "digest": {
					const proc = details.process as BgProcessInfo | undefined;
					if (proc) {
						const statusIcon = proc.status === "ready" ? theme.fg("success", "✓")
							: proc.status === "error" ? theme.fg("error", "✗")
							: theme.fg("warning", "⋯");
						let text = `${statusIcon} ${theme.fg("accent", proc.id)} ${theme.fg("muted", proc.label)}`;
						if (expanded) {
							const rawText = result.content[0];
							if (rawText?.type === "text") {
								const lines = rawText.text.split("\n").slice(1);
								for (const line of lines.slice(0, 20)) {
									text += "\n  " + theme.fg("dim", line);
								}
							}
						}
						return new Text(text, 0, 0);
					}
					return new Text(theme.fg("dim", `${details.count ?? 0} process(es)`), 0, 0);
				}

				case "highlights": {
					const proc = details.process as BgProcessInfo;
					const lineCount = details.lineCount as number;
					let text = theme.fg("accent", proc.id) + " " + theme.fg("dim", `${lineCount} highlights`);
					if (expanded) {
						const rawText = result.content[0];
						if (rawText?.type === "text") {
							const lines = rawText.text.split("\n").slice(1);
							for (const line of lines.slice(0, 20)) {
								text += "\n  " + theme.fg("toolOutput", line);
							}
						}
					}
					return new Text(text, 0, 0);
				}

				case "output": {
					const proc = details.process as BgProcessInfo;
					const statusIcon = proc.alive
						? (proc.status === "ready" ? theme.fg("success", "●") : proc.status === "error" ? theme.fg("error", "●") : theme.fg("warning", "●"))
						: theme.fg("error", "○");
					let text = `${statusIcon} ${theme.fg("accent", proc.id)} ${theme.fg("muted", proc.label)}`;

					if (expanded) {
						const rawText = result.content[0];
						if (rawText?.type === "text") {
							const lines = rawText.text.split("\n").slice(1);
							const show = lines.slice(0, 30);
							for (const line of show) {
								text += "\n  " + theme.fg("toolOutput", line);
							}
							if (lines.length > 30) {
								text += `\n  ${theme.fg("dim", `... ${lines.length - 30} more lines`)}`;
							}
						}
					} else {
						text += " " + theme.fg("dim", `(${proc.stdoutLines} stdout, ${proc.stderrLines} stderr lines)`);
					}
					return new Text(text, 0, 0);
				}

				case "wait_for_ready": {
					const proc = details.process as BgProcessInfo;
					const ready = details.ready as boolean;
					if (ready) {
						let text = theme.fg("success", "✓ Ready ") + theme.fg("accent", proc.id);
						if (proc.ports.length > 0) text += " " + theme.fg("dim", `:${proc.ports.join(",")}`);
						if (proc.urls.length > 0) text += " " + theme.fg("dim", proc.urls[0]);
						return new Text(text, 0, 0);
					} else {
						return new Text(
							theme.fg("error", "✗ Not ready ") + theme.fg("accent", proc.id) + " " + theme.fg("dim", String(details.detail)),
							0, 0,
						);
					}
				}

				case "send": {
					const proc = details.process as BgProcessInfo;
					return new Text(
						theme.fg("success", "→ ") + theme.fg("muted", `stdin → ${proc.id}`),
						0, 0,
					);
				}

				case "send_and_wait": {
					const proc = details.process as BgProcessInfo;
					const matched = details.matched as boolean;
					if (matched) {
						return new Text(
							theme.fg("success", "✓ ") + theme.fg("muted", `Pattern matched — ${proc.id}`),
							0, 0,
						);
					}
					return new Text(
						theme.fg("warning", "✗ ") + theme.fg("muted", `Timed out — ${proc.id}`),
						0, 0,
					);
				}

				case "run": {
					const proc = details.process as BgProcessInfo;
					const exitCode = details.exitCode as number;
					const timedOut = details.timedOut as boolean;
					if (timedOut) {
						let text = theme.fg("warning", "⏱ Timed out ") + theme.fg("accent", proc.id);
						if (expanded) {
							const rawText = result.content[0];
							if (rawText?.type === "text") {
								const lines = rawText.text.split("\n").slice(1);
								for (const line of lines.slice(0, 30)) {
									text += "\n  " + theme.fg("toolOutput", line);
								}
							}
						}
						return new Text(text, 0, 0);
					}
					const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					let text = `${icon} ${theme.fg("accent", proc.id)} ${theme.fg("dim", `exit:${exitCode}`)}`;
					if (expanded) {
						const rawText = result.content[0];
						if (rawText?.type === "text") {
							const lines = rawText.text.split("\n").slice(1);
							for (const line of lines.slice(0, 30)) {
								text += "\n  " + theme.fg("toolOutput", line);
							}
							if (lines.length > 30) {
								text += `\n  ${theme.fg("dim", `... ${lines.length - 30} more lines`)}`;
							}
						}
					}
					return new Text(text, 0, 0);
				}

				case "signal": {
					const sig = details.signal as string;
					const proc = details.process as BgProcessInfo;
					return new Text(
						theme.fg("warning", `${sig} `) + theme.fg("muted", `→ ${proc.id}`),
						0, 0,
					);
				}

				case "list": {
					const procs = details.processes as BgProcessInfo[];
					if (procs.length === 0) {
						return new Text(theme.fg("dim", "No background processes"), 0, 0);
					}
					let text = theme.fg("muted", `${procs.length} background process(es)`);
					if (expanded) {
						for (const p of procs) {
							const statusIcon = p.alive
								? (p.status === "ready" ? theme.fg("success", "●") : p.status === "error" ? theme.fg("error", "●") : theme.fg("warning", "●"))
								: theme.fg("error", "○");
							const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
							text += `\n  ${statusIcon} ${theme.fg("accent", p.id)}  ${theme.fg("dim", p.uptime)}  ${theme.fg("muted", p.label)}  [${p.processType}]${portInfo}`;
						}
					}
					return new Text(text, 0, 0);
				}

				case "kill": {
					const proc = details.process as BgProcessInfo;
					return new Text(
						theme.fg("success", "✓ Killed ") + theme.fg("accent", proc.id) + " " + theme.fg("muted", proc.label),
						0, 0,
					);
				}

				case "restart": {
					const proc = details.process as BgProcessInfo;
					return new Text(
						theme.fg("success", "↻ Restarted ") + theme.fg("accent", proc.id) + " " + theme.fg("muted", proc.label) + " " + theme.fg("dim", `#${proc.restartCount}`),
						0, 0,
					);
				}

				case "env": {
					const proc = details.process as BgProcessInfo;
					const envData = details.env as { cwd: string; shell: string } | undefined;
					let text = theme.fg("accent", proc.id) + " " + theme.fg("muted", proc.label);
					if (envData) {
						text += " " + theme.fg("dim", `cwd: ${envData.cwd}`);
					}
					if (expanded) {
						const rawText = result.content[0];
						if (rawText?.type === "text") {
							const lines = rawText.text.split("\n").slice(1);
							for (const line of lines.slice(0, 15)) {
								text += "\n  " + theme.fg("dim", line);
							}
						}
					}
					return new Text(text, 0, 0);
				}

				case "group_status": {
					const gs = details.groupStatus as ReturnType<typeof getGroupStatus> | undefined;
					if (gs) {
						const icon = gs.healthy ? theme.fg("success", "✓") : theme.fg("error", "✗");
						return new Text(
							`${icon} ${theme.fg("accent", gs.group)} — ${gs.processes.length} process(es)`,
							0, 0,
						);
					}
					const groups = details.groups as string[];
					return new Text(theme.fg("dim", `${groups?.length ?? 0} group(s)`), 0, 0);
				}

				default: {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}
			}
		},
	});

	// ── Slash command: /bg ────────────────────────────────────────────────

	pi.registerCommand("bg", {
		description: "Manage background processes: /bg [list|output|kill|killall|groups] [id]",

		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "output", "kill", "killall", "groups", "digest"];
			const parts = prefix.trim().split(/\s+/);

			if (parts.length <= 1) {
				return subcommands
					.filter(cmd => cmd.startsWith(parts[0] ?? ""))
					.map(cmd => ({ value: cmd, label: cmd }));
			}

			if (parts[0] === "output" || parts[0] === "kill" || parts[0] === "digest") {
				const idPrefix = parts[1] ?? "";
				return Array.from(processes.values())
					.filter(p => p.id.startsWith(idPrefix))
					.map(p => ({
						value: `${parts[0]} ${p.id}`,
						label: `${p.id} — ${p.label}`,
					}));
			}

			return [];
		},

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "list";

			if (sub === "list" || sub === "") {
				if (processes.size === 0) {
					ctx.ui.notify("No background processes.", "info");
					return;
				}

				if (!ctx.hasUI) {
					const lines = Array.from(processes.values()).map(p => {
						const statusIcon = p.alive
							? (p.status === "ready" ? "✓" : p.status === "error" ? "✗" : "⋯")
							: "○";
						const uptime = formatUptime(Date.now() - p.startedAt);
						const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
						return `${p.id}  ${statusIcon} ${p.status}  ${uptime}  ${p.label}  [${p.processType}]${portInfo}`;
					});
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						return new BgManagerOverlay(tui, theme, () => {
							done();
							refreshWidget();
						});
					},
					{
						overlay: true,
						overlayOptions: {
							width: "60%",
							minWidth: 50,
							maxHeight: "70%",
							anchor: "center",
						},
					},
				);
				return;
			}

			if (sub === "output" || sub === "digest") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify(`Usage: /bg ${sub} <id>`, "error");
					return;
				}
				const bg = processes.get(id);
				if (!bg) {
					ctx.ui.notify(`No process with id '${id}'`, "error");
					return;
				}

				if (!ctx.hasUI) {
					if (sub === "digest") {
						const digest = generateDigest(bg);
						ctx.ui.notify(formatDigestText(bg, digest), "info");
					} else {
						const output = getOutput(bg, { stream: "both", tail: 50 });
						ctx.ui.notify(output || "(no output)", "info");
					}
					return;
				}

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						const overlay = new BgManagerOverlay(tui, theme, () => {
							done();
							refreshWidget();
						});
						const procs = Array.from(processes.values());
						const idx = procs.findIndex(p => p.id === id);
						if (idx >= 0) overlay.selectAndView(idx);
						return overlay;
					},
					{
						overlay: true,
						overlayOptions: {
							width: "60%",
							minWidth: 50,
							maxHeight: "70%",
							anchor: "center",
						},
					},
				);
				return;
			}

			if (sub === "kill") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("Usage: /bg kill <id>", "error");
					return;
				}
				const bg = processes.get(id);
				if (!bg) {
					ctx.ui.notify(`No process with id '${id}'`, "error");
					return;
				}
				killProcess(id, "SIGTERM");
				await new Promise(r => setTimeout(r, 300));
				if (bg.alive) {
					killProcess(id, "SIGKILL");
					await new Promise(r => setTimeout(r, 200));
				}
				if (!bg.alive) processes.delete(id);
				ctx.ui.notify(`Killed process ${id} (${bg.label})`, "info");
				return;
			}

			if (sub === "killall") {
				const count = processes.size;
				cleanupAll();
				ctx.ui.notify(`Killed ${count} background process(es)`, "info");
				return;
			}

			if (sub === "groups") {
				const groups = new Set<string>();
				for (const p of processes.values()) {
					if (p.group) groups.add(p.group);
				}
				if (groups.size === 0) {
					ctx.ui.notify("No process groups defined.", "info");
					return;
				}
				const lines = Array.from(groups).map(g => {
					const gs = getGroupStatus(g);
					const icon = gs.healthy ? "✓" : "✗";
					const procs = gs.processes.map(p => `${p.id}(${p.status})`).join(", ");
					return `${icon} ${g}: ${procs}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify("Usage: /bg [list|output|digest|kill|killall|groups] [id]", "info");
		},
	});

	// ── Live Footer ──────────────────────────────────────────────────────

	/** Whether we currently own the footer via setFooter */
	let footerActive = false;

	function buildBgStatusText(th: Theme): string {
		const alive = Array.from(processes.values()).filter(p => p.alive);
		if (alive.length === 0) return "";

		const sep = th.fg("dim", " · ");
		const items: string[] = [];
		for (const p of alive) {
			const statusIcon = p.status === "ready" ? th.fg("success", "●")
				: p.status === "error" ? th.fg("error", "●")
				: th.fg("warning", "●");
			const name = p.label.length > 14 ? p.label.slice(0, 12) + "…" : p.label;
			const portInfo = p.ports.length > 0 ? th.fg("dim", `:${p.ports[0]}`) : "";
			const errBadge = p.recentErrors.length > 0
				? th.fg("error", ` err:${p.recentErrors.length}`)
				: "";
			items.push(`${statusIcon} ${th.fg("muted", name)}${portInfo}${errBadge}`);
		}
		return items.join(sep);
	}

	/** Reference to tui for triggering re-renders when footer is active */
	let footerTui: { requestRender: () => void } | null = null;

	function refreshWidget() {
		if (!latestCtx?.hasUI) return;
		const alive = Array.from(processes.values()).filter(p => p.alive);

		if (alive.length === 0) {
			if (footerActive) {
				latestCtx.ui.setFooter(undefined);
				footerActive = false;
				footerTui = null;
			}
			return;
		}

		if (footerActive) {
			// Footer already installed — just trigger a re-render
			footerTui?.requestRender();
			return;
		}

		// Install custom footer that puts bg process info right-aligned on line 1
		footerActive = true;
		latestCtx.ui.setFooter((tui, th, footerData) => {
			footerTui = tui;
			const branchUnsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				render(width: number): string[] {
					// ── Line 1: pwd (branch) [session]  ...  bg status ──
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = latestCtx?.sessionManager?.getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const bgStatus = buildBgStatusText(th);
					const leftPwd = th.fg("dim", pwd);
					const leftWidth = visibleWidth(leftPwd);
					const rightWidth = visibleWidth(bgStatus);

					let pwdLine: string;
					const minGap = 2;
					if (bgStatus && leftWidth + minGap + rightWidth <= width) {
						const pad = " ".repeat(width - leftWidth - rightWidth);
						pwdLine = leftPwd + pad + bgStatus;
					} else if (bgStatus) {
						// Truncate pwd to make room for bg status
						const availForPwd = width - rightWidth - minGap;
						if (availForPwd > 10) {
							const truncPwd = truncateToWidth(leftPwd, availForPwd, th.fg("dim", "…"));
							const truncWidth = visibleWidth(truncPwd);
							const pad = " ".repeat(Math.max(0, width - truncWidth - rightWidth));
							pwdLine = truncPwd + pad + bgStatus;
						} else {
							pwdLine = truncateToWidth(leftPwd, width, th.fg("dim", "…"));
						}
					} else {
						pwdLine = truncateToWidth(leftPwd, width, th.fg("dim", "…"));
					}

					// ── Line 2: token stats (left) ... model (right) ──
					const ctx = latestCtx;
					const sm = ctx?.sessionManager;
					let totalInput = 0, totalOutput = 0;
					let totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
					if (sm) {
						for (const entry of sm.getEntries()) {
							if (entry.type === "message" && (entry as any).message?.role === "assistant") {
								const u = (entry as any).message.usage;
								if (u) {
									totalInput += u.input || 0;
									totalOutput += u.output || 0;
									totalCacheRead += u.cacheRead || 0;
									totalCacheWrite += u.cacheWrite || 0;
									totalCost += u.cost?.total || 0;
								}
							}
						}
					}

					const contextUsage = ctx?.getContextUsage?.();
					const contextWindow = contextUsage?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? (contextPercentValue).toFixed(1) : "?";

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokenCount(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokenCount(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokenCount(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokenCount(totalCacheWrite)}`);
					if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

					const contextDisplay = contextPercent === "?"
						? `?/${formatTokenCount(contextWindow)}`
						: `${contextPercent}%/${formatTokenCount(contextWindow)}`;
					let contextStr: string;
					if (contextPercentValue > 90) {
						contextStr = th.fg("error", contextDisplay);
					} else if (contextPercentValue > 70) {
						contextStr = th.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}
					statsParts.push(contextStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx?.model?.id || "no-model";
					let rightSide = modelName;
					if (ctx?.model?.reasoning) {
						const thinkingLevel = (ctx as any).getThinkingLevel?.() || "off";
						rightSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx?.model) {
						const withProvider = `(${ctx.model.provider}) ${rightSide}`;
						if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
							rightSide = withProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightSideWidth <= width) {
						const pad = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + pad + rightSide;
					} else {
						const avail = width - statsLeftWidth - 2;
						if (avail > 0) {
							const truncRight = truncateToWidth(rightSide, avail, "");
							const truncRightWidth = visibleWidth(truncRight);
							const pad = " ".repeat(Math.max(0, width - statsLeftWidth - truncRightWidth));
							statsLine = statsLeft + pad + truncRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = th.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = th.fg("dim", remainder);

					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// ── Line 3 (optional): other extension statuses ──
					const extensionStatuses = footerData.getExtensionStatuses();
					// Filter out our own bg-shell status since it's already on line 1
					const otherStatuses = Array.from(extensionStatuses.entries())
						.filter(([key]) => key !== "bg-shell")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (otherStatuses.length > 0) {
						lines.push(truncateToWidth(otherStatuses.join(" "), width, th.fg("dim", "...")));
					}

					return lines;
				},
				invalidate() {},
				dispose() {
					branchUnsub();
					footerTui = null;
				},
			};
		});
	}

	// Periodic maintenance
	const maintenanceInterval = setInterval(() => {
		pruneDeadProcesses();
		refreshWidget();
		// Persist manifest periodically
		if (latestCtx) {
			persistManifest(latestCtx.cwd);
		}
	}, 2000);

	// Refresh widget after agent actions and session events
	const refreshHandler = async (_event: unknown, ctx: ExtensionContext) => {
		latestCtx = ctx;
		refreshWidget();
	};
	pi.on("turn_end", refreshHandler as any);
	pi.on("agent_end", refreshHandler as any);
	pi.on("session_start", refreshHandler as any);
	pi.on("session_switch", refreshHandler as any);

	pi.on("tool_execution_end", async (_event, ctx) => {
		latestCtx = ctx;
		refreshWidget();
	});

	// ── Ctrl+Alt+B shortcut ──────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: shortcutDesc("Open background process manager", "/bg"),
		handler: async (ctx) => {
			latestCtx = ctx;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					return new BgManagerOverlay(tui, theme, () => {
						done();
						refreshWidget();
					});
				},
				{
					overlay: true,
					overlayOptions: {
						width: "60%",
						minWidth: 50,
						maxHeight: "70%",
						anchor: "center",
					},
				},
			);
		},
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async () => {
		clearInterval(maintenanceInterval);
		if (latestCtx) persistManifest(latestCtx.cwd);
		cleanupAll();
	});
}
