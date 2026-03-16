/**
 * Expect-style interactions: send_and_wait, run on session, query shell environment.
 */

import { randomUUID } from "node:crypto";
import type { BgProcess } from "./types.js";

// ── Query Shell Environment ────────────────────────────────────────────────

export async function queryShellEnv(
	bg: BgProcess,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ cwd: string; env: Record<string, string>; shell: string } | null> {
	const sentinel = `__GSD_ENV_${randomUUID().slice(0, 8)}__`;
	const startIndex = bg.output.length;

	const cmd = [
		`echo "${sentinel}_START"`,
		`echo "CWD=$(pwd)"`,
		`echo "SHELL=$SHELL"`,
		`echo "PATH=$PATH"`,
		`echo "VIRTUAL_ENV=$VIRTUAL_ENV"`,
		`echo "NODE_ENV=$NODE_ENV"`,
		`echo "HOME=$HOME"`,
		`echo "USER=$USER"`,
		`echo "NVM_DIR=$NVM_DIR"`,
		`echo "GOPATH=$GOPATH"`,
		`echo "CARGO_HOME=$CARGO_HOME"`,
		`echo "PYTHONPATH=$PYTHONPATH"`,
		`echo "${sentinel}_END"`,
	].join(" && ");

	bg.proc.stdin?.write(cmd + "\n");

	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (signal?.aborted) return null;
		if (!bg.alive) return null;

		const newEntries = bg.output.slice(startIndex);
		const endIdx = newEntries.findIndex(e => e.line.includes(`${sentinel}_END`));
		if (endIdx >= 0) {
			const startIdx = newEntries.findIndex(e => e.line.includes(`${sentinel}_START`));
			if (startIdx >= 0) {
				const envLines = newEntries.slice(startIdx + 1, endIdx);
				const env: Record<string, string> = {};
				let cwd = "";
				let shell = "";

				for (const entry of envLines) {
					const match = entry.line.match(/^([A-Z_]+)=(.*)$/);
					if (match) {
						const [, key, value] = match;
						if (key === "CWD") {
							cwd = value;
						} else if (key === "SHELL") {
							shell = value;
						} else if (value) {
							env[key] = value;
						}
					}
				}

				return { cwd, env, shell };
			}
		}

		await new Promise(r => setTimeout(r, 100));
	}

	return null;
}

// ── Send and Wait ──────────────────────────────────────────────────────────

export async function sendAndWait(
	bg: BgProcess,
	input: string,
	waitPattern: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ matched: boolean; output: string }> {
	// Snapshot the current position in the unified buffer before sending
	const startIndex = bg.output.length;
	bg.proc.stdin?.write(input + "\n");

	let re: RegExp;
	try {
		re = new RegExp(waitPattern, "i");
	} catch {
		return { matched: false, output: "Invalid wait pattern regex" };
	}

	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (signal?.aborted) {
			const newEntries = bg.output.slice(startIndex);
			return { matched: false, output: newEntries.map(e => e.line).join("\n") || "(cancelled)" };
		}
		const newEntries = bg.output.slice(startIndex);
		for (const entry of newEntries) {
			if (re.test(entry.line)) {
				return { matched: true, output: newEntries.map(e => e.line).join("\n") };
			}
		}
		await new Promise(r => setTimeout(r, 100));
	}

	const newEntries = bg.output.slice(startIndex);
	return { matched: false, output: newEntries.map(e => e.line).join("\n") || "(no output)" };
}

// ── Run on Session ─────────────────────────────────────────────────────────

export async function runOnSession(
	bg: BgProcess,
	command: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
	const sentinel = randomUUID().slice(0, 8);
	const startMarker = `__GSD_SENTINEL_${sentinel}_START__`;
	const endMarker = `__GSD_SENTINEL_${sentinel}_END__`;
	const exitVar = `__GSD_EXIT_${sentinel}__`;

	// Snapshot current output buffer position
	const startIndex = bg.output.length;

	// Write the sentinel-wrapped command to stdin
	const wrappedCommand = [
		`echo ${startMarker}`,
		command,
		`${exitVar}=$?`,
		`echo ${endMarker} $${exitVar}`,
	].join("\n");
	bg.proc.stdin?.write(wrappedCommand + "\n");

	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (signal?.aborted) {
			const newEntries = bg.output.slice(startIndex);
			return { exitCode: -1, output: newEntries.map(e => e.line).join("\n") || "(cancelled)", timedOut: false };
		}

		// Process died while waiting
		if (!bg.alive) {
			const newEntries = bg.output.slice(startIndex);
			const lines = newEntries.map(e => e.line);
			return { exitCode: bg.proc.exitCode ?? -1, output: lines.join("\n") || "(process exited)", timedOut: false };
		}

		const newEntries = bg.output.slice(startIndex);
		for (let i = 0; i < newEntries.length; i++) {
			if (newEntries[i].line.includes(endMarker)) {
				// Parse exit code from the END sentinel line
				const endLine = newEntries[i].line;
				const exitMatch = endLine.match(new RegExp(`${endMarker}\\s+(\\d+)`));
				const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : -1;

				// Extract output between START and END sentinels
				const outputLines: string[] = [];
				let capturing = false;
				for (let j = 0; j < newEntries.length; j++) {
					if (newEntries[j].line.includes(startMarker)) {
						capturing = true;
						continue;
					}
					if (newEntries[j].line.includes(endMarker)) {
						break;
					}
					if (capturing) {
						outputLines.push(newEntries[j].line);
					}
				}

				return { exitCode, output: outputLines.join("\n"), timedOut: false };
			}
		}

		await new Promise(r => setTimeout(r, 100));
	}

	// Timed out
	const newEntries = bg.output.slice(startIndex);
	const outputLines: string[] = [];
	let capturing = false;
	for (const entry of newEntries) {
		if (entry.line.includes(startMarker)) {
			capturing = true;
			continue;
		}
		if (capturing) {
			outputLines.push(entry.line);
		}
	}
	return { exitCode: -1, output: outputLines.join("\n") || "(no output)", timedOut: true };
}
