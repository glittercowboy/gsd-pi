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
 *   bg_shell — start, output, digest, wait_for_ready, send, send_and_wait,
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
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getShellConfig,
	sanitizeCommand,
} from "@gsd/pi-coding-agent";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	matchesKey,
	Key,
} from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { shortcutDesc } from "../shared/terminal.js";
import { createRequire } from "node:module";

// ── Windows VT Input Restoration ────────────────────────────────────────────
// Child processes (esp. Git Bash / MSYS2) can strip the ENABLE_VIRTUAL_TERMINAL_INPUT
// flag from the shared stdin console handle. Re-enable it after each child exits.

let _vtHandles: { GetConsoleMode: Function; SetConsoleMode: Function; handle: unknown } | null = null;
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
		if (!(mode[0] & ENABLE_VIRTUAL_TERMINAL_INPUT)) {
			_vtHandles.SetConsoleMode(_vtHandles.handle, mode[0] | ENABLE_VIRTUAL_TERMINAL_INPUT);
		}
	} catch { /* koffi not available on non-Windows */ }
}

// ── Types ──────────────────────────────────────────────────────────────────

type ProcessStatus =
	| "starting"
	| "ready"
	| "error"
	| "exited"
	| "crashed";

type ProcessType = "server" | "build" | "test" | "watcher" | "generic" | "shell";

interface ProcessEvent {
	type:
		| "started"
		| "ready"
		| "error_detected"
		| "recovered"
		| "exited"
		| "crashed"
		| "output"
		| "port_open"
		| "pattern_match";
	timestamp: number;
	detail: string;
	data?: Record<string, unknown>;
}

interface OutputDigest {
	status: ProcessStatus;
	uptime: string;
	errors: string[];
	warnings: string[];
	urls: string[];
	ports: number[];
	lastActivity: string;
	outputLines: number;
	changeSummary: string;
}

interface OutputLine {
	stream: "stdout" | "stderr";
	line: string;
	ts: number;
}

interface BgProcess {
	id: string;
	label: string;
	command: string;
	cwd: string;
	startedAt: number;
	proc: ChildProcess;
	/** Unified chronologically-interleaved output buffer */
	output: OutputLine[];
	exitCode: number | null;
	signal: string | null;
	alive: boolean;
	/** Tracks how many lines in the unified output buffer the LLM has already seen */
	lastReadIndex: number;
	/** Process classification */
	processType: ProcessType;
	/** Current lifecycle status */
	status: ProcessStatus;
	/** Detected ports */
	ports: number[];
	/** Detected URLs */
	urls: string[];
	/** Accumulated errors since last read */
	recentErrors: string[];
	/** Accumulated warnings since last read */
	recentWarnings: string[];
	/** Lifecycle events log */
	events: ProcessEvent[];
	/** Ready pattern (regex string) */
	readyPattern: string | null;
	/** Ready port to probe */
	readyPort: number | null;
	/** Whether readiness was ever achieved */
	wasReady: boolean;
	/** Group membership */
	group: string | null;
	/** Last error count snapshot for diff detection */
	lastErrorCount: number;
	/** Last warning count snapshot for diff detection */
	lastWarningCount: number;
	/** Command history for shell-type sessions */
	commandHistory: string[];
	/** Dedup tracker: hash → count of repeated lines */
	lineDedup: Map<string, number>;
	/** Total raw lines (before dedup) for token savings calc */
	totalRawLines: number;
	/** Env snapshot (keys only, no values for security) */
	envKeys: string[];
	/** Restart count */
	restartCount: number;
	/** Original start config for restart */
	startConfig: { command: string; cwd: string; label: string; processType: ProcessType; readyPattern: string | null; readyPort: number | null; group: string | null };
}

interface BgProcessInfo {
	id: string;
	label: string;
	command: string;
	cwd: string;
	startedAt: number;
	alive: boolean;
	exitCode: number | null;
	signal: string | null;
	outputLines: number;
	stdoutLines: number;
	stderrLines: number;
	status: ProcessStatus;
	processType: ProcessType;
	ports: number[];
	urls: string[];
	group: string | null;
	restartCount: number;
	uptime: string;
	recentErrorCount: number;
	recentWarningCount: number;
	eventCount: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BUFFER_LINES = 5000;
const MAX_EVENTS = 200;
const DEAD_PROCESS_TTL = 10 * 60 * 1000;
const PORT_PROBE_TIMEOUT = 500;
const READY_POLL_INTERVAL = 250;
const DEFAULT_READY_TIMEOUT = 30000;

// ── Pattern Databases ──────────────────────────────────────────────────────

/** Patterns that indicate a process is ready/listening */
const READINESS_PATTERNS: RegExp[] = [
	// Node/JS servers
	/listening\s+on\s+(?:port\s+)?(\d+)/i,
	/server\s+(?:is\s+)?(?:running|started|listening)\s+(?:at|on)\s+/i,
	/ready\s+(?:in|on|at)\s+/i,
	/started\s+(?:server\s+)?on\s+/i,
	// Next.js / Vite / etc
	/Local:\s*https?:\/\//i,
	/➜\s+Local:\s*/i,
	/compiled\s+(?:successfully|client\s+and\s+server)/i,
	// Python
	/running\s+on\s+https?:\/\//i,
	/Uvicorn\s+running/i,
	/Development\s+server\s+is\s+running/i,
	// Generic
	/press\s+ctrl[\-+]c\s+to\s+(?:quit|stop)/i,
	/watching\s+for\s+(?:file\s+)?changes/i,
	/build\s+(?:completed|succeeded|finished)/i,
];

/** Patterns that indicate errors */
const ERROR_PATTERNS: RegExp[] = [
	/\berror\b[\s:[\](]/i,
	/\bERROR\b/,
	/\bfailed\b/i,
	/\bFAILED\b/,
	/\bfatal\b/i,
	/\bFATAL\b/,
	/\bexception\b/i,
	/\bpanic\b/i,
	/\bsegmentation\s+fault\b/i,
	/\bsyntax\s*error\b/i,
	/\btype\s*error\b/i,
	/\breference\s*error\b/i,
	/Cannot\s+find\s+module/i,
	/Module\s+not\s+found/i,
	/ENOENT/,
	/EACCES/,
	/EADDRINUSE/,
	/TS\d{4,5}:/,     // TypeScript errors
	/E\d{4,5}:/,      // Rust errors
	/\[ERROR\]/,
	/✖|✗|❌/,          // Common error symbols
];

/** Patterns that indicate warnings */
const WARNING_PATTERNS: RegExp[] = [
	/\bwarning\b[\s:[\](]/i,
	/\bWARN(?:ING)?\b/,
	/\bdeprecated\b/i,
	/\bDEPRECATED\b/,
	/⚠️?/,
	/\[WARN\]/,
];

/** Patterns to extract URLs */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Patterns to extract port numbers from "listening" messages */
const PORT_PATTERN = /(?:port|listening\s+on|:)\s*(\d{2,5})\b/gi;

/** Patterns indicating test results */
const TEST_RESULT_PATTERNS: RegExp[] = [
	/(\d+)\s+(?:tests?\s+)?passed/i,
	/(\d+)\s+(?:tests?\s+)?failed/i,
	/Tests?:\s+(\d+)\s+passed/i,
	/(\d+)\s+passing/i,
	/(\d+)\s+failing/i,
	/PASS|FAIL/,
];

/** Patterns indicating build completion */
const BUILD_COMPLETE_PATTERNS: RegExp[] = [
	/build\s+(?:completed|succeeded|finished|done)/i,
	/compiled\s+(?:successfully|with\s+\d+\s+(?:error|warning))/i,
	/✓\s+Built/i,
	/webpack\s+\d+\.\d+/i,
	/bundle\s+(?:is\s+)?ready/i,
];

// ── Process Registry ───────────────────────────────────────────────────────

const processes = new Map<string, BgProcess>();

/** Pending alerts to inject into the next agent context */
let pendingAlerts: string[] = [];

function addOutputLine(bg: BgProcess, stream: "stdout" | "stderr", line: string): void {
	bg.output.push({ stream, line, ts: Date.now() });
	if (bg.output.length > MAX_BUFFER_LINES) {
		const excess = bg.output.length - MAX_BUFFER_LINES;
		bg.output.splice(0, excess);
		// Adjust the read cursor so incremental delivery stays correct
		bg.lastReadIndex = Math.max(0, bg.lastReadIndex - excess);
	}
}

function addEvent(bg: BgProcess, event: Omit<ProcessEvent, "timestamp">): void {
	const ev: ProcessEvent = { ...event, timestamp: Date.now() };
	bg.events.push(ev);
	if (bg.events.length > MAX_EVENTS) {
		bg.events.splice(0, bg.events.length - MAX_EVENTS);
	}
}

function getInfo(p: BgProcess): BgProcessInfo {
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

function detectProcessType(command: string): ProcessType {
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

// ── Output Analysis ────────────────────────────────────────────────────────

function analyzeLine(bg: BgProcess, line: string, stream: "stdout" | "stderr"): void {
	// Error detection
	if (ERROR_PATTERNS.some(p => p.test(line))) {
		bg.recentErrors.push(line.trim().slice(0, 200)); // Cap line length
		if (bg.recentErrors.length > 50) bg.recentErrors.splice(0, bg.recentErrors.length - 50);

		if (bg.status === "ready") {
			bg.status = "error";
			addEvent(bg, {
				type: "error_detected",
				detail: line.trim().slice(0, 200),
				data: { errorCount: bg.recentErrors.length },
			});
			pushAlert(bg, `error_detected: ${line.trim().slice(0, 120)}`);
		}
	}

	// Warning detection
	if (WARNING_PATTERNS.some(p => p.test(line))) {
		bg.recentWarnings.push(line.trim().slice(0, 200));
		if (bg.recentWarnings.length > 50) bg.recentWarnings.splice(0, bg.recentWarnings.length - 50);
	}

	// URL extraction
	const urlMatches = line.match(URL_PATTERN);
	if (urlMatches) {
		for (const url of urlMatches) {
			if (!bg.urls.includes(url)) {
				bg.urls.push(url);
			}
		}
	}

	// Port extraction
	let portMatch: RegExpExecArray | null;
	const portRe = new RegExp(PORT_PATTERN.source, PORT_PATTERN.flags);
	while ((portMatch = portRe.exec(line)) !== null) {
		const port = parseInt(portMatch[1], 10);
		if (port > 0 && port <= 65535 && !bg.ports.includes(port)) {
			bg.ports.push(port);
			addEvent(bg, {
				type: "port_open",
				detail: `Port ${port} detected`,
				data: { port },
			});
		}
	}

	// Readiness detection
	if (bg.status === "starting") {
		// Check custom ready pattern first
		if (bg.readyPattern) {
			try {
				if (new RegExp(bg.readyPattern, "i").test(line)) {
					transitionToReady(bg, `Custom pattern matched: ${line.trim().slice(0, 100)}`);
				}
			} catch { /* invalid regex, skip */ }
		}

		// Check built-in readiness patterns
		if (bg.status === "starting" && READINESS_PATTERNS.some(p => p.test(line))) {
			transitionToReady(bg, `Readiness pattern matched: ${line.trim().slice(0, 100)}`);
		}
	}

	// Recovery detection: if we were in error and see a success pattern
	if (bg.status === "error") {
		if (READINESS_PATTERNS.some(p => p.test(line)) || BUILD_COMPLETE_PATTERNS.some(p => p.test(line))) {
			bg.status = "ready";
			bg.recentErrors = [];
			addEvent(bg, { type: "recovered", detail: "Process recovered from error state" });
			pushAlert(bg, "recovered — errors cleared");
		}
	}

	// Dedup tracking
	bg.totalRawLines++;
	const lineHash = line.trim().slice(0, 100);
	bg.lineDedup.set(lineHash, (bg.lineDedup.get(lineHash) || 0) + 1);
}

function transitionToReady(bg: BgProcess, detail: string): void {
	bg.status = "ready";
	bg.wasReady = true;
	addEvent(bg, { type: "ready", detail });
}

function pushAlert(bg: BgProcess, message: string): void {
	pendingAlerts.push(`[bg:${bg.id} ${bg.label}] ${message}`);
}

// ── Port Probing ───────────────────────────────────────────────────────────

function probePort(port: number, host: string = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host, timeout: PORT_PROBE_TIMEOUT }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

// ── Digest Generation ──────────────────────────────────────────────────────

function generateDigest(bg: BgProcess, mutate: boolean = false): OutputDigest {
	// Change summary: what's different since last read
	const newErrors = bg.recentErrors.length - bg.lastErrorCount;
	const newWarnings = bg.recentWarnings.length - bg.lastWarningCount;
	const newLines = bg.output.length - bg.lastReadIndex;

	let changeSummary: string;
	if (newLines === 0) {
		changeSummary = "no new output";
	} else {
		const parts: string[] = [];
		parts.push(`${newLines} new lines`);
		if (newErrors > 0) parts.push(`${newErrors} new errors`);
		if (newWarnings > 0) parts.push(`${newWarnings} new warnings`);
		changeSummary = parts.join(", ");
	}

	// Only mutate snapshot counters when explicitly requested (e.g. from tool calls)
	if (mutate) {
		bg.lastErrorCount = bg.recentErrors.length;
		bg.lastWarningCount = bg.recentWarnings.length;
	}

	return {
		status: bg.status,
		uptime: formatUptime(Date.now() - bg.startedAt),
		errors: bg.recentErrors.slice(-5), // Last 5 errors
		warnings: bg.recentWarnings.slice(-3), // Last 3 warnings
		urls: bg.urls,
		ports: bg.ports,
		lastActivity: bg.events.length > 0
			? formatTimeAgo(bg.events[bg.events.length - 1].timestamp)
			: "none",
		outputLines: bg.output.length,
		changeSummary,
	};
}

// ── Highlight Extraction ───────────────────────────────────────────────────

function getHighlights(bg: BgProcess, maxLines: number = 15): string[] {
	const lines: string[] = [];

	// Collect significant lines
	const significant: { line: string; score: number; idx: number }[] = [];
	for (let i = 0; i < bg.output.length; i++) {
		const entry = bg.output[i];
		let score = 0;
		if (ERROR_PATTERNS.some(p => p.test(entry.line))) score += 10;
		if (WARNING_PATTERNS.some(p => p.test(entry.line))) score += 5;
		if (URL_PATTERN.test(entry.line)) score += 3;
		if (READINESS_PATTERNS.some(p => p.test(entry.line))) score += 8;
		if (TEST_RESULT_PATTERNS.some(p => p.test(entry.line))) score += 7;
		if (BUILD_COMPLETE_PATTERNS.some(p => p.test(entry.line))) score += 6;
		// Boost recent lines so highlights favor fresh output over stale
		if (i >= bg.output.length - 50) score += 2;
		if (score > 0) {
			significant.push({ line: entry.line.trim().slice(0, 300), score, idx: i });
		}
	}

	// Sort by significance (tie-break by recency)
	significant.sort((a, b) => b.score - a.score || b.idx - a.idx);
	const top = significant.slice(0, maxLines);

	if (top.length === 0) {
		// If nothing significant, show last few lines
		const tail = bg.output.slice(-5);
		for (const l of tail) lines.push(l.line.trim().slice(0, 300));
	} else {
		for (const entry of top) lines.push(entry.line);
	}

	return lines;
}

// ── Process Start ──────────────────────────────────────────────────────────

interface StartOptions {
	command: string;
	cwd: string;
	label?: string;
	type?: ProcessType;
	readyPattern?: string;
	readyPort?: number;
	group?: string;
	env?: Record<string, string>;
}

function startProcess(opts: StartOptions): BgProcess {
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
		startPortProbing(bg, bg.readyPort);
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

// ── Port Probing Loop ──────────────────────────────────────────────────────

function startPortProbing(bg: BgProcess, port: number): void {
	const interval = setInterval(async () => {
		if (!bg.alive || bg.status !== "starting") {
			clearInterval(interval);
			return;
		}
		const open = await probePort(port);
		if (open) {
			clearInterval(interval);
			if (!bg.ports.includes(port)) bg.ports.push(port);
			transitionToReady(bg, `Port ${port} is open`);
			addEvent(bg, { type: "port_open", detail: `Port ${port} is open`, data: { port } });
		}
	}, READY_POLL_INTERVAL);

	// Stop probing after timeout
	setTimeout(() => clearInterval(interval), DEFAULT_READY_TIMEOUT);
}

// ── Process Kill ───────────────────────────────────────────────────────────

function killProcess(id: string, sig: NodeJS.Signals = "SIGTERM"): boolean {
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

async function restartProcess(id: string): Promise<BgProcess | null> {
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

// ── Output Retrieval (multi-tier) ──────────────────────────────────────────

interface GetOutputOptions {
	stream: "stdout" | "stderr" | "both";
	tail?: number;
	filter?: string;
	incremental?: boolean;
}

function getOutput(bg: BgProcess, opts: GetOutputOptions): string {
	const { stream, tail, filter, incremental } = opts;

	// Get the relevant slice of the unified buffer (already in chronological order)
	let entries: OutputLine[];
	if (incremental) {
		entries = bg.output.slice(bg.lastReadIndex);
		bg.lastReadIndex = bg.output.length;
	} else {
		entries = [...bg.output];
	}

	// Filter by stream if requested
	if (stream !== "both") {
		entries = entries.filter(e => e.stream === stream);
	}

	// Apply regex filter
	if (filter) {
		try {
			const re = new RegExp(filter, "i");
			entries = entries.filter(e => re.test(e.line));
		} catch { /* invalid regex */ }
	}

	// Tail
	if (tail && tail > 0 && entries.length > tail) {
		entries = entries.slice(-tail);
	}

	const lines = entries.map(e => e.line);
	const raw = lines.join("\n");
	const truncation = truncateHead(raw, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let result = truncation.content;
	if (truncation.truncated) {
		result += `\n\n[Output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines]`;
	}
	return result;
}

// ── Wait for Ready ─────────────────────────────────────────────────────────

async function waitForReady(bg: BgProcess, timeout: number, signal?: AbortSignal): Promise<{ ready: boolean; detail: string }> {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		if (signal?.aborted) {
			return { ready: false, detail: "Cancelled" };
		}
		if (!bg.alive) {
			return {
				ready: false,
				detail: `Process exited before becoming ready (code ${bg.exitCode})${bg.recentErrors.length > 0 ? ` — ${bg.recentErrors.slice(-1)[0]}` : ""}`,
			};
		}
		if (bg.status === "ready") {
			return {
				ready: true,
				detail: bg.events.find(e => e.type === "ready")?.detail || "Process is ready",
			};
		}
		await new Promise(r => setTimeout(r, READY_POLL_INTERVAL));
	}

	// Timeout — try port probe as last resort
	if (bg.readyPort) {
		const open = await probePort(bg.readyPort);
		if (open) {
			transitionToReady(bg, `Port ${bg.readyPort} is open (detected at timeout)`);
			return { ready: true, detail: `Port ${bg.readyPort} is open` };
		}
	}

	return { ready: false, detail: `Timed out after ${timeout}ms waiting for ready signal` };
}

// ── Send and Wait ──────────────────────────────────────────────────────────

async function sendAndWait(
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

// ── Group Operations ───────────────────────────────────────────────────────

function getGroupProcesses(group: string): BgProcess[] {
	return Array.from(processes.values()).filter(p => p.group === group);
}

function getGroupStatus(group: string): {
	group: string;
	healthy: boolean;
	processes: { id: string; label: string; status: ProcessStatus; alive: boolean }[];
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

// ── Persistence ────────────────────────────────────────────────────────────

interface ProcessManifest {
	id: string;
	label: string;
	command: string;
	cwd: string;
	startedAt: number;
	processType: ProcessType;
	group: string | null;
	readyPattern: string | null;
	readyPort: number | null;
	pid: number | undefined;
}

function getManifestPath(cwd: string): string {
	const dir = join(cwd, ".bg-shell");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "manifest.json");
}

function persistManifest(cwd: string): void {
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

function loadManifest(cwd: string): ProcessManifest[] {
	try {
		const path = getManifestPath(cwd);
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf-8"));
		}
	} catch { /* best effort */ }
	return [];
}

// ── Utilities ──────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatTimeAgo(timestamp: number): string {
	return formatUptime(Date.now() - timestamp) + " ago";
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function pruneDeadProcesses(): void {
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

function cleanupAll(): void {
	for (const [id, bg] of processes) {
		if (bg.alive) killProcess(id, "SIGKILL");
	}
	processes.clear();
}

// ── Format Digest for LLM ──────────────────────────────────────────────────

function formatDigestText(bg: BgProcess, digest: OutputDigest): string {
	let text = `Process ${bg.id} (${bg.label}):\n`;
	text += `  status: ${digest.status}\n`;
	text += `  type: ${bg.processType}\n`;
	text += `  uptime: ${digest.uptime}\n`;

	if (digest.ports.length > 0) text += `  ports: ${digest.ports.join(", ")}\n`;
	if (digest.urls.length > 0) text += `  urls: ${digest.urls.join(", ")}\n`;

	text += `  output: ${digest.outputLines} lines\n`;
	text += `  changes: ${digest.changeSummary}`;

	if (digest.errors.length > 0) {
		text += `\n  errors (${digest.errors.length}):`;
		for (const err of digest.errors) {
			text += `\n    - ${err}`;
		}
	}
	if (digest.warnings.length > 0) {
		text += `\n  warnings (${digest.warnings.length}):`;
		for (const w of digest.warnings) {
			text += `\n    - ${w}`;
		}
	}

	return text;
}

// ── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | null = null;

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		cleanupAll();
	});

	// ── Compaction Awareness: Survive Context Resets ───────────────────

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
			const surviving: ProcessManifest[] = [];
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
			"Use 'send_and_wait' for interactive CLIs: send input and wait for expected output pattern.",
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
				"signal",
				"list",
				"kill",
				"restart",
				"group_status",
			] as const),
			command: Type.Optional(
				Type.String({ description: "Shell command to run (for start)" }),
			),
			label: Type.Optional(
				Type.String({ description: "Short human-readable label for the process (for start)" }),
			),
			id: Type.Optional(
				Type.String({ description: "Process ID (for digest, output, highlights, wait_for_ready, send, send_and_wait, signal, kill, restart)" }),
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
				Type.Number({ description: "Timeout in milliseconds (for wait_for_ready, send_and_wait). Default: 30000" }),
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

	function formatTokenCount(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
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

// ── TUI: Process Manager Overlay ───────────────────────────────────────────

class BgManagerOverlay {
	private tui: { requestRender: () => void };
	private theme: Theme;
	private onClose: () => void;
	private selected = 0;
	private mode: "list" | "output" | "events" = "list";
	private viewingProcess: BgProcess | null = null;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		tui: { requestRender: () => void },
		theme: Theme,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.refreshTimer = setInterval(() => {
			this.invalidate();
			this.tui.requestRender();
		}, 1000);
	}

	private getProcessList(): BgProcess[] {
		return Array.from(processes.values());
	}

	selectAndView(index: number): void {
		const procs = this.getProcessList();
		if (index >= 0 && index < procs.length) {
			this.selected = index;
			this.viewingProcess = procs[index];
			this.mode = "output";
			this.scrollOffset = Math.max(0, procs[index].output.length - 20);
		}
	}

	handleInput(data: string): void {
		if (this.mode === "output") {
			this.handleOutputInput(data);
			return;
		}
		if (this.mode === "events") {
			this.handleEventsInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		const procs = this.getProcessList();

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("b"))) {
			clearInterval(this.refreshTimer);
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.selected > 0) {
				this.selected--;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.selected < procs.length - 1) {
				this.selected++;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const proc = procs[this.selected];
			if (proc) {
				this.viewingProcess = proc;
				this.mode = "output";
				this.scrollOffset = Math.max(0, proc.output.length - 20);
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// e = view events
		if (data === "e") {
			const proc = procs[this.selected];
			if (proc) {
				this.viewingProcess = proc;
				this.mode = "events";
				this.scrollOffset = Math.max(0, proc.events.length - 15);
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// r = restart
		if (data === "r") {
			const proc = procs[this.selected];
			if (proc) {
				restartProcess(proc.id).then(() => {
					this.invalidate();
					this.tui.requestRender();
				});
			}
			return;
		}

		// x or d = kill selected
		if (data === "x" || data === "d") {
			const proc = procs[this.selected];
			if (proc && proc.alive) {
				killProcess(proc.id, "SIGTERM");
				setTimeout(() => {
					if (proc.alive) killProcess(proc.id, "SIGKILL");
					this.invalidate();
					this.tui.requestRender();
				}, 300);
			}
			return;
		}

		// X or D = kill all
		if (data === "X" || data === "D") {
			cleanupAll();
			this.selected = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
	}

	private handleOutputInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.mode = "list";
			this.viewingProcess = null;
			this.scrollOffset = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Tab to switch to events view
		if (matchesKey(data, Key.tab)) {
			this.mode = "events";
			if (this.viewingProcess) {
				this.scrollOffset = Math.max(0, this.viewingProcess.events.length - 15);
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.viewingProcess) {
				const total = this.viewingProcess.output.length;
				this.scrollOffset = Math.min(this.scrollOffset + 5, Math.max(0, total - 20));
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 5);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (data === "G") {
			if (this.viewingProcess) {
				const total = this.viewingProcess.output.length;
				this.scrollOffset = Math.max(0, total - 20);
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (data === "g") {
			this.scrollOffset = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
	}

	private handleEventsInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.mode = "list";
			this.viewingProcess = null;
			this.scrollOffset = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Tab to switch back to output view
		if (matchesKey(data, Key.tab)) {
			this.mode = "output";
			if (this.viewingProcess) {
				this.scrollOffset = Math.max(0, this.viewingProcess.output.length - 20);
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.viewingProcess) {
				this.scrollOffset = Math.min(this.scrollOffset + 3, Math.max(0, this.viewingProcess.events.length - 10));
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 3);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		let lines: string[];
		if (this.mode === "events") {
			lines = this.renderEvents(width);
		} else if (this.mode === "output") {
			lines = this.renderOutput(width);
		} else {
			lines = this.renderList(width);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private box(inner: string[], width: number): string[] {
		const th = this.theme;
		const bdr = (s: string) => th.fg("borderMuted", s);
		const iw = width - 4;
		const lines: string[] = [];

		lines.push(bdr("╭" + "─".repeat(width - 2) + "╮"));
		for (const line of inner) {
			const truncated = truncateToWidth(line, iw);
			const pad = Math.max(0, iw - visibleWidth(truncated));
			lines.push(bdr("│") + " " + truncated + " ".repeat(pad) + " " + bdr("│"));
		}
		lines.push(bdr("╰" + "─".repeat(width - 2) + "╯"));
		return lines;
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const procs = this.getProcessList();
		const inner: string[] = [];

		if (procs.length === 0) {
			inner.push(th.fg("dim", "No background processes."));
			inner.push("");
			inner.push(th.fg("dim", "esc close"));
			return this.box(inner, width);
		}

		inner.push(th.fg("dim", "Background Processes"));
		inner.push("");

		for (let i = 0; i < procs.length; i++) {
			const p = procs[i];
			const sel = i === this.selected;
			const pointer = sel ? th.fg("accent", "▸ ") : "  ";

			const statusIcon = p.alive
				? (p.status === "ready" ? th.fg("success", "●")
					: p.status === "error" ? th.fg("error", "●")
					: th.fg("warning", "●"))
				: th.fg("dim", "○");

			const uptime = th.fg("dim", formatUptime(Date.now() - p.startedAt));
			const name = sel ? th.fg("text", p.label) : th.fg("muted", p.label);
			const typeTag = th.fg("dim", `[${p.processType}]`);
			const portInfo = p.ports.length > 0 ? th.fg("dim", ` :${p.ports.join(",")}`) : "";
			const errBadge = p.recentErrors.length > 0 ? th.fg("error", ` ⚠${p.recentErrors.length}`) : "";
			const groupTag = p.group ? th.fg("dim", ` {${p.group}}`) : "";
			const restartBadge = p.restartCount > 0 ? th.fg("warning", ` ↻${p.restartCount}`) : "";

			const status = p.alive ? "" : "  " + th.fg("dim", `exit ${p.exitCode}`);

			inner.push(`${pointer}${statusIcon} ${name} ${typeTag} ${uptime}${portInfo}${errBadge}${groupTag}${restartBadge}${status}`);
		}

		inner.push("");
		inner.push(th.fg("dim", "↑↓ select · enter output · e events · r restart · x kill · esc close"));

		return this.box(inner, width);
	}

	private renderOutput(width: number): string[] {
		const th = this.theme;
		const p = this.viewingProcess;
		if (!p) return [""];
		const inner: string[] = [];

		const statusIcon = p.alive
			? (p.status === "ready" ? th.fg("success", "●")
				: p.status === "error" ? th.fg("error", "●")
				: th.fg("warning", "●"))
			: th.fg("dim", "○");
		const name = th.fg("muted", p.label);
		const uptime = th.fg("dim", formatUptime(Date.now() - p.startedAt));
		const typeTag = th.fg("dim", `[${p.processType}]`);
		const portInfo = p.ports.length > 0 ? th.fg("dim", ` :${p.ports.join(",")}`) : "";
		const tabIndicator = th.fg("accent", "[Output]") + " " + th.fg("dim", "Events");

		inner.push(`${statusIcon} ${name} ${typeTag} ${uptime}${portInfo}  ${tabIndicator}`);
		inner.push("");

		// Unified buffer is already chronologically interleaved
		const allOutput = p.output;

		const maxVisible = 18;
		const visible = allOutput.slice(this.scrollOffset, this.scrollOffset + maxVisible);

		if (allOutput.length === 0) {
			inner.push(th.fg("dim", "(no output)"));
		} else {
			for (const entry of visible) {
				const isError = ERROR_PATTERNS.some(pat => pat.test(entry.line));
				const isWarning = !isError && WARNING_PATTERNS.some(pat => pat.test(entry.line));
				const prefix = entry.stream === "stderr" ? th.fg("error", "⚠ ") : "";
				const color = isError ? "error" : isWarning ? "warning" : "dim";
				inner.push(prefix + th.fg(color, entry.line));
			}

			if (allOutput.length > maxVisible) {
				inner.push("");
				const pos = `${this.scrollOffset + 1}–${Math.min(this.scrollOffset + maxVisible, allOutput.length)} of ${allOutput.length}`;
				inner.push(th.fg("dim", pos));
			}
		}

		inner.push("");
		inner.push(th.fg("dim", "↑↓ scroll · g/G top/end · tab events · q back"));

		return this.box(inner, width);
	}

	private renderEvents(width: number): string[] {
		const th = this.theme;
		const p = this.viewingProcess;
		if (!p) return [""];
		const inner: string[] = [];

		const statusIcon = p.alive
			? (p.status === "ready" ? th.fg("success", "●")
				: p.status === "error" ? th.fg("error", "●")
				: th.fg("warning", "●"))
			: th.fg("dim", "○");
		const name = th.fg("muted", p.label);
		const uptime = th.fg("dim", formatUptime(Date.now() - p.startedAt));
		const tabIndicator = th.fg("dim", "Output") + " " + th.fg("accent", "[Events]");

		inner.push(`${statusIcon} ${name} ${uptime}  ${tabIndicator}`);
		inner.push("");

		if (p.events.length === 0) {
			inner.push(th.fg("dim", "(no events)"));
		} else {
			const maxVisible = 15;
			const visible = p.events.slice(this.scrollOffset, this.scrollOffset + maxVisible);

			for (const ev of visible) {
				const time = th.fg("dim", formatTimeAgo(ev.timestamp));
				const typeColor = ev.type === "crashed" || ev.type === "error_detected" ? "error"
					: ev.type === "ready" || ev.type === "recovered" ? "success"
					: ev.type === "port_open" ? "accent"
					: "dim";
				const typeLabel = th.fg(typeColor, ev.type);
				inner.push(`${time}  ${typeLabel}`);
				inner.push(`  ${th.fg("dim", ev.detail.slice(0, 80))}`);
			}

			if (p.events.length > maxVisible) {
				inner.push("");
				inner.push(th.fg("dim", `${this.scrollOffset + 1}–${Math.min(this.scrollOffset + maxVisible, p.events.length)} of ${p.events.length} events`));
			}
		}

		inner.push("");
		inner.push(th.fg("dim", "↑↓ scroll · tab output · q back"));

		return this.box(inner, width);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
