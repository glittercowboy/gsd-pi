/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, unlinkSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildProcess, spawn } from "child_process";

/** Track temp files created by bash execution for cleanup on exit. */
const bashTempFiles = new Set<string>();

let cleanupRegistered = false;
function registerTempCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	process.on("exit", () => {
		for (const file of bashTempFiles) {
			try {
				unlinkSync(file);
			} catch {
				// Best-effort cleanup
			}
		}
	});
}
import { processStreamChunk, type StreamState } from "@gsd/native";
import { getShellConfig, getShellEnv, killProcessTree, DEFAULT_MAX_BYTES, truncateTail } from "@gsd/pi-coding-agent";

// sanitizeCommand was removed from @gsd/pi-coding-agent 0.67.2. The function
// stripped null bytes and other control characters that could confuse the shell.
// Phase 09: move to @gsd/agent-types or inline permanently.
export function sanitizeCommand(cmd: string): string {
	// Remove null bytes and ASCII control characters (except newline/tab which are valid in scripts)
	// eslint-disable-next-line no-control-regex -- intentional: sanitizing shell command input
	return cmd.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Dynamically import a sibling module relative to an extension's import.meta.url.
 * Replaces the removed @gsd/pi-coding-agent importExtensionModule (0.67.2).
 *
 * Usage: const mod = await importExtensionModule<typeof import("./foo.js")>(import.meta.url, "./foo.js");
 */
export async function importExtensionModule<T = unknown>(parentModuleUrl: string, specifier: string): Promise<T> {
	const resolvedPath = fileURLToPath(new URL(specifier, parentModuleUrl));
	return import(resolvedPath) as Promise<T>;
}

import type { BashOperations } from "@gsd/agent-types";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command with optional streaming and cancellation support.
 *
 * Features:
 * - Streams sanitized output via onChunk callback
 * - Writes large output to temp file for later retrieval
 * - Supports cancellation via AbortSignal
 * - Sanitizes output (strips ANSI, removes binary garbage, normalizes newlines)
 * - Truncates output if it exceeds the default max bytes
 *
 * @param command - The bash command to execute
 * @param options - Optional streaming callback and abort signal
 * @returns Promise resolving to execution result
 */
export function executeBash(command: string, options?: BashExecutorOptions & { loginShell?: boolean }): Promise<BashResult> {
	// Check abort BEFORE spawning to avoid leaking the child process
	if (options?.signal?.aborted) {
		return Promise.resolve({ output: "", exitCode: undefined, cancelled: true, truncated: false });
	}

	return new Promise((resolve, reject) => {
		let shell: string;
		let args: string[];
		if (options?.loginShell) {
			// Use the user's login shell with -l for PATH/env from shell profiles
			shell = process.env.SHELL || "/bin/bash";
			args = ["-l", "-c"];
		} else {
			({ shell, args } = getShellConfig());
		}
		// On Windows, detached: true sets CREATE_NEW_PROCESS_GROUP which can
		// cause EINVAL in VSCode/ConPTY terminal contexts.  The bg-shell
		// extension already guards this (process-manager.ts); align here.
		// Process-tree cleanup uses taskkill /F /T on Windows regardless.
		const child: ChildProcess = spawn(shell, [...args, sanitizeCommand(command)], {
			detached: process.platform !== "win32",
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Track sanitized output for truncation
		const outputChunks: string[] = [];
		let outputBytes = 0;
		const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

		// Temp file for large output
		let tempFilePath: string | undefined;
		let tempFileStream: WriteStream | undefined;
		let totalBytes = 0;

		// Handle abort signal
		const abortHandler = (): void => {
			if (child.pid) {
				killProcessTree(child.pid);
			}
		};

		if (options?.signal) {
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		let streamState: StreamState | undefined;

		const handleData = (data: Buffer): void => {
			totalBytes += data.length;

			// Single-pass native processing: UTF-8 decode + ANSI strip + binary sanitize + CR removal
			const result = processStreamChunk(data, streamState);
			streamState = result.state;
			const text = result.text;

			// Start writing to temp file if exceeds threshold
			if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
				registerTempCleanup();
				const id = randomBytes(8).toString("hex");
				tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
				bashTempFiles.add(tempFilePath);
				tempFileStream = createWriteStream(tempFilePath);
				// Write already-buffered chunks to temp file
				for (const chunk of outputChunks) {
					tempFileStream.write(chunk);
				}
			}

			if (tempFileStream) {
				tempFileStream.write(text);
			}

			// Keep rolling buffer of sanitized text
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}

			// Stream to callback if provided
			if (options?.onChunk) {
				options.onChunk(text);
			}
		};

		child.stdout?.on("data", handleData);
		child.stderr?.on("data", handleData);

		child.on("close", (code) => {
			// Clean up abort listener
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}

			if (tempFileStream && !tempFileStream.writableEnded) {
				tempFileStream.end();
			}

			// Combine buffered chunks for truncation (already sanitized)
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);

			// code === null means killed (cancelled)
			const cancelled = code === null;

			resolve({
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: cancelled ? undefined : code,
				cancelled,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			});
		});

		child.on("error", (err) => {
			// Clean up abort listener
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}

			if (tempFileStream) {
				tempFileStream.end();
			}

			reject(err);
		});
	});
}

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	let streamState2: StreamState | undefined;

	const onData = (data: Buffer): void => {
		totalBytes += data.length;

		// Single-pass native processing: UTF-8 decode + ANSI strip + binary sanitize + CR removal
		const result = processStreamChunk(data, streamState2);
		streamState2 = result.state;
		const text = result.text;

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
			registerTempCleanup();
			const id = randomBytes(8).toString("hex");
			tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
			bashTempFiles.add(tempFilePath);
			tempFileStream = createWriteStream(tempFilePath);
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		if (tempFileStream) {
			tempFileStream.end();
		}

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		if (tempFileStream) {
			tempFileStream.end();
		}

		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		throw err;
	}
}
