/**
 * Process lifecycle management: start, stop, restart, signal, state tracking,
 * process registry, and persistence.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getShellConfig, sanitizeCommand } from "@gsd/pi-coding-agent";
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

/** Replace the pendingAlerts array (used by the extension entry point) */
export function setPendingAlerts(alerts: string[]): void {
	pendingAlerts = alerts;
}

export function addOutputLine(bg: BgProcess, stream: "stdout" | "stderr", line: string): void {
	bg.output.push({ stream, line, ts: Date.now() });
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

export function pushAlert(bg: BgProcess, message: string): void {
	pendingAlerts.push(`[bg:${bg.id} ${bg.label}] ${message}`);
}

export function getInfo(p: BgProcess): BgProcessInfo {
	const stdoutLines = p.output.filter(l => l.stream === "stdout").length;
	const stderrLines = p.output.filter(l => l.stream === "stderr").length;
	return {
		id: p.id,
		label: p.label,
		command: p.command,
		cwd: p.cwd,
		startedAt: p.startedAt,
		alive: p.alive,
		exitCode: p.exitCode,
		signal: p.signal,
		outputLines: p.output.length,
		stdoutLines,
		stderrLines,
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
	const command = processType === "shell" && !opts.command ? shell : opts.command;
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
		commandHistory: [],
		lineDedup: new Map(),
		totalRawLines: 0,
		envKeys: Object.keys(opts.env || {}),
		restartCount: 0,
		startConfig: {
			command,
			cwd: opts.cwd,
			label: opts.label || command.slice(0, 60),
			processType,
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
