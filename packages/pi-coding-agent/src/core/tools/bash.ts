import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@gsd/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeCommand } from "../../utils/shell.js";
import { type BashInterceptorRule, compileInterceptor, DEFAULT_BASH_INTERCEPTOR_RULES } from "./bash-interceptor.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";
import type { ArtifactManager } from "../artifact-manager.js";

// Cached Win32 FFI handles for restoring VT input after child processes
let _vtHandles: { GetConsoleMode: any; SetConsoleMode: any; handle: any } | null = null;
function restoreWindowsVTInput(): void {
	if (process.platform !== "win32") return;
	try {
		if (!_vtHandles) {
			const cjsRequire = createRequire(import.meta.url);
			const koffi = cjsRequire("koffi");
			const k32 = koffi.load("kernel32.dll");
			const GetStdHandle = k32.func("void* __stdcall GetStdHandle(int)");
			const GetConsoleMode = k32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
			const SetConsoleMode = k32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");
			const handle = GetStdHandle(-10);
			_vtHandles = { GetConsoleMode, SetConsoleMode, handle };
		}
		const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
		const mode = new Uint32Array(1);
		_vtHandles.GetConsoleMode(_vtHandles.handle, mode);
		if (!(mode[0]! & ENABLE_VIRTUAL_TERMINAL_INPUT)) {
			_vtHandles.SetConsoleMode(_vtHandles.handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT);
		}
	} catch { /* koffi not available */ }
}

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

/**
 * Detect whether a command fragment ends with an unquoted & (background operator).
 * Returns true for patterns like: `cmd &`, `cmd arg &`, `cmd & disown`, `(cmd) &`.
 * Returns false when & appears inside a string literal or as &&.
 */
function endsWithBackgroundOperator(fragment: string): boolean {
	// Remove content inside single-quoted strings to avoid false positives
	const stripped = fragment.replace(/'[^']*'/g, "''");
	// Match trailing & not preceded by another & (i.e., not &&)
	return /(?<!&)&\s*(?:disown\s*)?(?:#.*)?$/.test(stripped.trim());
}

/**
 * Determine whether a command segment already redirects stdout away from the terminal.
 * Checks for >, >>, &>, |, /dev/null redirects.
 */
function hasOutputRedirect(segment: string): boolean {
	// Remove single-quoted strings to avoid matching inside them
	const stripped = segment.replace(/'[^']*'/g, "''");
	// Match >, >> not preceded by 2 (stderr-only) — we only care about stdout
	// Also match &> (combined), >&, or a pipe | which routes stdout elsewhere
	return /(?<!\d)(?:>>?|&>|>&|\|)/.test(stripped);
}

/**
 * Rewrite a command that uses & for backgrounding so the background process
 * does not inherit the bash tool's stdout/stderr pipes.
 *
 * Without this, `python -m http.server 8080 &` causes the bash tool to hang
 * indefinitely because Node.js keeps the pipe open until every process that
 * inherited it exits — including the long-running server.
 *
 * The rewrite adds `>/dev/null 2>&1` before each & where stdout is not already
 * redirected, ensuring the background process detaches from the pipes while
 * still producing a human-readable notice in the tool output.
 *
 * Returns { command: string; rewritten: boolean }.
 */
export function rewriteBackgroundCommand(command: string): { command: string; rewritten: boolean } {
	// Quick pre-check: if there's no & at all, skip the more expensive processing
	if (!command.includes("&")) return { command, rewritten: false };

	// Split on ; and newlines to handle compound commands.
	// We rewrite each segment independently.
	// Note: this is intentionally simple and covers the common LLM patterns.
	// It does not attempt to parse complex nested subshells.
	const segments = command.split(/(?<=[;\n])/);
	let anyRewritten = false;

	const rewrittenSegments = segments.map((segment) => {
		if (!endsWithBackgroundOperator(segment)) return segment;
		if (hasOutputRedirect(segment)) return segment;

		anyRewritten = true;
		// Insert >/dev/null 2>&1 before the trailing & (and optional disown/comment)
		return segment.replace(
			/(?<!&)(&\s*(?:disown\s*)?(?:#.*)?)$/,
			">/dev/null 2>&1 $1",
		);
	});

	if (!anyRewritten) return { command, rewritten: false };
	return { command: rewrittenSegments.join(""), rewritten: true };
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	artifactId?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (e.g., SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command - The command to execute
	 * @param cwd - Working directory
	 * @param options - Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Default bash operations using local shell
 */
const defaultBashOperations: BashOperations = {
	exec: (command, cwd, { onData, signal, timeout, env }) => {
		return new Promise((resolve, reject) => {
			const { shell, args } = getShellConfig();

			if (!existsSync(cwd)) {
				reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
				return;
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: true,
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;

			// Set timeout if provided
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeout * 1000);
			}

			// Stream stdout and stderr
			if (child.stdout) {
				child.stdout.on("data", onData);
			}
			if (child.stderr) {
				child.stderr.on("data", onData);
			}

			// Handle shell spawn errors
			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				reject(err);
			});

			// Handle abort signal - kill entire process tree
			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// Handle process exit
			child.on("close", (code) => {
				restoreWindowsVTInput();
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);

				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				if (timedOut) {
					reject(new Error(`timeout:${timeout}`));
					return;
				}

				resolve({ exitCode: code });
			});
		});
	},
};

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = {
		command,
		cwd,
		env: { ...getShellEnv() },
	};

	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (e.g., "shopt -s expand_aliases" for alias support) */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Session-scoped artifact storage. When provided, spills to artifact files instead of temp files. */
	artifactManager?: ArtifactManager;
	/** Bash interceptor configuration — blocks commands that duplicate dedicated tools */
	interceptor?: {
		enabled: boolean;
		rules?: BashInterceptorRule[];
	};
	/** Tool names available in the session, used by the interceptor to check if replacement tools exist */
	availableToolNames?: string[] | (() => string[]);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const ops = options?.operations ?? defaultBashOperations;
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const artifactManager = options?.artifactManager;

	// Pre-compile interceptor rules once at construction time
	const interceptorInstance =
		options?.interceptor?.enabled
			? compileInterceptor(options.interceptor.rules ?? DEFAULT_BASH_INTERCEPTOR_RULES)
			: null;

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			// Check bash interceptor — block commands that duplicate dedicated tools
			if (interceptorInstance) {
				const toolNames =
					typeof options!.availableToolNames === "function"
						? options!.availableToolNames()
						: options!.availableToolNames ?? [];
				const interception = interceptorInstance.check(command, toolNames);
				if (interception.block) {
					return {
						content: [{ type: "text" as const, text: interception.message ?? "Command blocked by interceptor" }],
						details: undefined,
					};
				}
			}

			// Rewrite background commands (&) to redirect output away from the pipes.
			// Without this, `cmd &` causes the tool to hang because the background
			// process inherits the piped stdout/stderr and keeps them open indefinitely.
			const bgResult = rewriteBackgroundCommand(command);
			const effectiveCommand = bgResult.command;
			if (bgResult.rewritten) {
				// Surface a brief advisory so the LLM knows what happened.
				// The rewrite is transparent for the common case; explicit detachment
				// (nohup, start_new_session) is preferred for robustness.
				onUpdate?.({
					content: [{
						type: "text" as const,
						text: "Note: Background command output redirected to /dev/null to prevent pipe hang. Use nohup or setsid for reliable detachment.",
					}],
					details: undefined,
				});
			}
			// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
			const resolvedCommand = sanitizeCommand(commandPrefix ? `${commandPrefix}\n${effectiveCommand}` : effectiveCommand);
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

			return new Promise((resolve, reject) => {
				// We'll stream to a file if output gets large
				let spillFilePath: string | undefined;
				let spillArtifactId: string | undefined;
				let spillFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;

				// Keep a rolling buffer of the last chunk for tail truncation
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				// Keep more than we need so we have enough for truncation
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const handleData = (data: Buffer) => {
					totalBytes += data.length;

					// Start writing to file once we exceed the threshold
					if (totalBytes > DEFAULT_MAX_BYTES && !spillFilePath) {
						if (artifactManager) {
							const allocated = artifactManager.allocatePath("bash");
							spillFilePath = allocated.path;
							spillArtifactId = allocated.id;
						} else {
							spillFilePath = getTempFilePath();
						}
						spillFileStream = createWriteStream(spillFilePath);
						// Write all buffered chunks to the file
						for (const chunk of chunks) {
							spillFileStream.write(chunk);
						}
					}

					// Write to temp file if we have one
					if (spillFileStream) {
						spillFileStream.write(data);
					}

					// Keep rolling buffer of recent data
					chunks.push(data);
					chunksBytes += data.length;

					// Trim old chunks if buffer is too large
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}

					// Stream partial output to callback (truncated rolling buffer)
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: spillFilePath,
							},
						});
					}
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						// Close temp file stream
						if (spillFileStream) {
							spillFileStream.end();
						}

						// Combine all buffered chunks
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");

						// Apply tail truncation
						const truncation = truncateTail(fullOutput);
						let outputText = truncation.content || "(no output)";

						// Build details with truncation info
						let details: BashToolDetails | undefined;

						if (truncation.truncated) {
							details = {
								truncation,
								fullOutputPath: spillFilePath,
								...(spillArtifactId ? { artifactId: spillArtifactId } : {}),
							};

							// Build actionable notice
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							const outputRef = spillArtifactId ? `artifact://${spillArtifactId}` : spillFilePath;

							if (truncation.lastLinePartial) {
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${outputRef}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${outputRef}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${outputRef}]`;
							}
						}

						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// Close temp file stream
						if (spillFileStream) {
							spillFileStream.end();
						}

						// Combine all buffered chunks for error output
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");

						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
	};
}

/** Default bash tool using process.cwd() - for backwards compatibility */
export const bashTool = createBashTool(process.cwd());
