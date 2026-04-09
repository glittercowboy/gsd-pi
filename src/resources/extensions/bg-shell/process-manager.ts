/**
 * Process lifecycle management: start, stop, restart, signal, state tracking,
 * process registry, and persistence.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getShellConfig, sanitizeCommand } from "@gsd/pi-coding-agent";
import { rewriteCommandWithRtk } from "../shared/rtk.js";
import type {
	BgProcess,
	BgProcessInfo,
	ProcessEvent,
	ProcessManifest,
	ProcessType,
	StartOptions,
} from "./types.js";
import {
	MAX_BUFFER_LINES,
	MAX_EVENTS,
	DEAD_PROCESS_TTL,
} from "./types.js";
import { restoreWindowsVTInput, formatUptime } from "./utilities.js";
import { analyzeLine } from "./output-formatter.js";
import { startPortProbing, transitionToReady } from "./readiness-detector.js";

// ── Process Registry ───────────────────────────────────────────────────────

export const processes = new Map<string, BgProcess>();

/** Pending alerts to inject into the next agent context */
export let pendingAlerts: string[] = [];

const MAX_PENDING_ALERTS = 50;

/** Replace the pendingAlerts array (used by the extension entry point) */
export function setPendingAlerts(alerts: string[]): void {
	pendingAlerts = alerts;
}

export function addOutputLine(bg: BgProcess, stream: "stdout" | "stderr", line: string): void {
	bg.output.push({ stream, line, ts: Date.now() });
	if (stream === "stdout") bg.stdoutLineCount++;
	else bg.stderrLineCount++;
	if (bg.output.length > MAX_BUFFER_LINES) {
		const excess = bg.output.length - MAX_BUFFER_LINES;
		bg.output.splice(0, excess);
		// Adjust the read cursor so incremental delivery stays correct
		bg.lastReadIndex = Math.max(0, bg.lastReadIndex - excess);
	}
}

export function addEvent(bg: BgProcess, event: Omit<ProcessEvent, "timestamp">): void {
	const ev: ProcessEvent = { ...event, timestamp: Date.now() };
	bg.events.push(ev);
	if (bg.events.length > MAX_EVENTS) {
		bg.events.splice(0, bg.events.length - MAX_EVENTS);
	}
}

export function pushAlert(bg: BgProcess | null, message: string): void {
	const prefix = bg ? `[bg:${bg.id} ${bg.label}] ` : "";
	pendingAlerts.push(`${prefix}${message}`);
	if (pendingAlerts.length > MAX_PENDING_ALERTS) {
		pendingAlerts.splice(0, pendingAlerts.length - MAX_PENDING_ALERTS);
	}
}

export function getInfo(p: BgProcess): BgProcessInfo {
	return {
		id: p.id,
		label: p.label,
		command: p.command,
		cwd: p.cwd,
		ownerSessionFile: p.ownerSessionFile,
		persistAcrossSessions: p.persistAcrossSessions,
		startedAt: p.startedAt,
		alive: p.alive,
		exitCode: p.exitCode,
		signal: p.signal,
		outputLines: p.output.length,
		stdoutLines: p.stdoutLineCount,
		stderrLines: p.stderrLineCount,
		status: p.status,
		processType: p.processType,
		ports: p.ports,
		urls: p.urls,
		group: p.group,
		restartCount: p.restartCount,
		uptime: formatUptime(Date.now() - p.startedAt),
		recentErrorCount: p.recentErrors.length,
		recentWarningCount: p.recentWarnings.length,
		eventCount: p.events.length,
	};
}

// ── Process Type Detection ─────────────────────────────────────────────────

export function detectProcessType(command: string): ProcessType {
	const cmd = command.toLowerCase();

	// Server patterns
	if (
		/\b(serve|server|dev|start)\b/.test(cmd) &&
		/\b(npm|yarn|pnpm|bun|node|next|vite|nuxt|astro|remix|gatsby|uvicorn|flask|django|rails|cargo)\b/.test(cmd)
	) return "server";
	if (/\b(uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|rails\s+s)\b/.test(cmd)) return "server";
	if (/\b(http-server|live-server|serve)\b/.test(cmd)) return "server";

	// Build patterns
	if (/\b(build|compile|make|tsc|webpack|rollup|esbuild|swc)\b/.test(cmd)) {
		if (/\b(watch|--watch|-w)\b/.test(cmd)) return "watcher";
		return "build";
	}

	// Test patterns
	if (/\b(test|jest|vitest|mocha|pytest|cargo\s+test|go\s+test|rspec)\b/.test(cmd)) return "test";

	// Watcher patterns
	if (/\b(watch|nodemon|chokidar|fswatch|inotifywait)\b/.test(cmd)) return "watcher";

	return "generic";
}

// ── Process Start ──────────────────────────────────────────────────────────

export function startProcess(opts: StartOptions): BgProcess {
	const id = randomUUID().slice(0, 8);
	const processType = opts.type || detectProcessType(opts.command);

	const env = { ...process.env, ...(opts.env || {}) };

	const { shell, args: shellArgs } = getShellConfig();
	// Shell sessions default to the user's shell if no command specified
	const command = processType === "shell" && !opts.command
		? shell
		: rewriteCommandWithRtk(opts.command);
	const proc = spawn(shell, [...shellArgs, sanitizeCommand(command)], {
		cwd: opts.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env,
		detached: process.platform !== "win32",
	});

	const bg: BgProcess = {
		id,
		label: opts.label || command.slice(0, 60),
		command,
		cwd: opts.cwd,
		ownerSessionFile: opts.ownerSessionFile ?? null,
		persistAcrossSessions: opts.persistAcrossSessions ?? false,
		startedAt: Date.now(),
		proc,
		output: [],
		exitCode: null,
		signal: null,
		alive: true,
		lastReadIndex: 0,
		processType,
		status: "starting",
		ports: [],
		urls: [],
		recentErrors: [],
		recentWarnings: [],
		events: [],
		readyPattern: opts.readyPattern || null,
		readyPort: opts.readyPort || null,
		wasReady: false,
		group: opts.group || null,
		lastErrorCount: 0,
		lastWarningCount: 0,
		stdoutLineCount: 0,
		stderrLineCount: 0,
		restartCount: 0,
		startConfig: {
			command,
			cwd: opts.cwd,
			label: opts.label || command.slice(0, 60),
			processType,
			ownerSessionFile: opts.ownerSessionFile ?? null,
			persistAcrossSessions: opts.persistAcrossSessions ?? false,
			readyPattern: opts.readyPattern || null,
			readyPort: opts.readyPort || null,
			group: opts.group || null,
		},
	};

	addEvent(bg, { type: "started", detail: `Process started: ${command.slice(0, 100)}` });

	proc.stdout?.on("data", (chunk: Buffer) => {
		const lines = chunk.toString().split("\n");
		for (const line of lines) {
			if (line.length > 0) {
				addOutputLine(bg, "stdout", line);
				analyzeLine(bg, line, "stdout");
			}
		}
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		const lines = chunk.toString().split("\n");
		for (const line of lines) {
			if (line.length > 0) {
				addOutputLine(bg, "stderr", line);
				analyzeLine(bg, line, "stderr");
			}
		}
	});

	proc.on("exit", (code, sig) => {
		restoreWindowsVTInput();
		bg.alive = false;
		bg.exitCode = code;
		bg.signal = sig ?? null;

		if (code === 0) {
			bg.status = "exited";
			addEvent(bg, { type: "exited", detail: `Exited cleanly (code 0)` });
		} else {
			bg.status = "crashed";
			const lastErrors = bg.recentErrors.slice(-3).join("; ");
			const detail = `Crashed with code ${code}${sig ? ` (signal ${sig})` : ""}${lastErrors ? ` — ${lastErrors}` : ""}`;
			addEvent(bg, {
				type: "crashed",
				detail,
				data: { exitCode: code, signal: sig, lastErrors: bg.recentErrors.slice(-5) },
			});
			pushAlert(bg, `CRASHED (code ${code})${lastErrors ? `: ${lastErrors.slice(0, 120)}` : ""}`);
		}
	});

	proc.on("error", (err) => {
		bg.alive = false;
		bg.status = "crashed";
		addOutputLine(bg, "stderr", `[spawn error] ${err.message}`);
		addEvent(bg, { type: "crashed", detail: `Spawn error: ${err.message}` });
		pushAlert(bg, `spawn error: ${err.message}`);
	});

	// Port probing for server-type processes
	if (bg.readyPort) {
		startPortProbing(bg, bg.readyPort, opts.readyTimeout);
	}

	// Shell sessions are ready immediately after spawn
	if (bg.processType === "shell") {
		setTimeout(() => {
			if (bg.alive && bg.status === "starting") {
				transitionToReady(bg, "Shell session initialized");
			}
		}, 200);
	}

	processes.set(id, bg);
	return bg;
}

// ── Process Kill ───────────────────────────────────────────────────────────

export function killProcess(id: string, sig: NodeJS.Signals = "SIGTERM"): boolean {
	const bg = processes.get(id);
	if (!bg) return false;
	if (!bg.alive) return true;
	try {
		if (process.platform === "win32") {
			// Windows: use taskkill /F /T to force-kill the entire process tree.
			// process.kill(-pid) (Unix process groups) does not work on Windows.
			if (bg.proc.pid) {
				const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(bg.proc.pid)], {
					timeout: 5000,
					encoding: "utf-8",
				});
				if (result.status !== 0 && result.status !== 128) {
					// taskkill failed — try the direct kill as fallback
					bg.proc.kill(sig);
				}
			} else {
				bg.proc.kill(sig);
			}
		} else {
			// Unix/macOS: kill the process group via negative PID
			if (bg.proc.pid) {
				try {
					process.kill(-bg.proc.pid, sig);
				} catch {
					bg.proc.kill(sig);
				}
			} else {
				bg.proc.kill(sig);
			}
		}
		return true;
	} catch {
		return false;
	}
}

// ── Process Restart ────────────────────────────────────────────────────────

export async function restartProcess(id: string): Promise<BgProcess | null> {
	const old = processes.get(id);
	if (!old) return null;

	const config = old.startConfig;
	const restartCount = old.restartCount + 1;

	// Kill old process
	if (old.alive) {
		killProcess(id, "SIGTERM");
		await new Promise(r => setTimeout(r, 300));
		if (old.alive) {
			killProcess(id, "SIGKILL");
			await new Promise(r => setTimeout(r, 200));
		}
	}
	processes.delete(id);

	// Start new one
	const newBg = startProcess({
		command: config.command,
		cwd: config.cwd,
		label: config.label,
		type: config.processType,
		ownerSessionFile: config.ownerSessionFile,
		persistAcrossSessions: config.persistAcrossSessions,
		readyPattern: config.readyPattern || undefined,
		readyPort: config.readyPort || undefined,
		group: config.group || undefined,
	});
	newBg.restartCount = restartCount;

	return newBg;
}

// ── Group Operations ───────────────────────────────────────────────────────

export function getGroupProcesses(group: string): BgProcess[] {
	return Array.from(processes.values()).filter(p => p.group === group);
}

export function getGroupStatus(group: string): {
	group: string;
	healthy: boolean;
	processes: { id: string; label: string; status: import("./types.js").ProcessStatus; alive: boolean }[];
} {
	const procs = getGroupProcesses(group);
	const healthy = procs.length > 0 && procs.every(p => p.alive && (p.status === "ready" || p.status === "starting"));
	return {
		group,
		healthy,
		processes: procs.map(p => ({
			id: p.id,
			label: p.label,
			status: p.status,
			alive: p.alive,
		})),
	};
}

// ── Cleanup ────────────────────────────────────────────────────────────────

export function pruneDeadProcesses(): void {
	const now = Date.now();
	for (const [id, bg] of processes) {
		if (!bg.alive) {
			const ttl = bg.processType === "shell" ? DEAD_PROCESS_TTL * 6 : DEAD_PROCESS_TTL;
			if (now - bg.startedAt > ttl) {
				processes.delete(id);
			}
		}
	}
}

export function cleanupAll(): void {
	for (const [id, bg] of processes) {
		if (bg.alive) killProcess(id, "SIGKILL");
	}
	processes.clear();
}

/**
 * Kill all alive, non-persistent bg processes.
 * Called between auto-mode units to prevent orphaned servers from
 * keeping ports bound across task boundaries (#1209).
 */
export function killSessionProcesses(): void {
	for (const [id, bg] of processes) {
		if (bg.alive && !bg.persistAcrossSessions) {
			killProcess(id, "SIGTERM");
		}
	}
}

async function waitForProcessExit(bg: BgProcess, timeoutMs: number): Promise<boolean> {
	if (!bg.alive) return true;
	await new Promise<void>((resolve) => {
		const done = () => resolve();
		const timer = setTimeout(done, timeoutMs);
		bg.proc.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	return !bg.alive;
}

export async function cleanupSessionProcesses(
	sessionFile: string,
	options?: { graceMs?: number },
): Promise<string[]> {
	const graceMs = Math.max(0, options?.graceMs ?? 300);
	const matches = Array.from(processes.values()).filter(
		(bg) => bg.alive && !bg.persistAcrossSessions && bg.ownerSessionFile === sessionFile,
	);
	if (matches.length === 0) return [];

	for (const bg of matches) {
		killProcess(bg.id, "SIGTERM");
	}
	if (graceMs > 0) {
		await Promise.all(matches.map((bg) => waitForProcessExit(bg, graceMs)));
	}
	for (const bg of matches) {
		if (bg.alive) killProcess(bg.id, "SIGKILL");
	}
	return matches.map((bg) => bg.id);
}

// ── Persistence ────────────────────────────────────────────────────────────

export function getManifestPath(cwd: string): string {
	const dir = join(cwd, ".bg-shell");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "manifest.json");
}

export function persistManifest(cwd: string): void {
	try {
		const manifest: ProcessManifest[] = Array.from(processes.values())
			.filter(p => p.alive)
			.map(p => ({
				id: p.id,
				label: p.label,
				command: p.command,
				cwd: p.cwd,
				ownerSessionFile: p.ownerSessionFile,
				persistAcrossSessions: p.persistAcrossSessions,
				startedAt: p.startedAt,
				processType: p.processType,
				group: p.group,
				readyPattern: p.readyPattern,
				readyPort: p.readyPort,
				pid: p.proc.pid,
			}));
		writeFileSync(getManifestPath(cwd), JSON.stringify(manifest, null, 2));
	} catch { /* best effort */ }
}

export function loadManifest(cwd: string): ProcessManifest[] {
	try {
		const path = getManifestPath(cwd);
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8"));
		}
	} catch { /* best effort */ }
	return [];
}
