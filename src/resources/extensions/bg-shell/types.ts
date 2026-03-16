/**
 * Shared types, constants, and pattern databases for the bg-shell extension.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ProcessStatus =
	| "starting"
	| "ready"
	| "error"
	| "exited"
	| "crashed";

export type ProcessType = "server" | "build" | "test" | "watcher" | "generic" | "shell";

export interface ProcessEvent {
	type:
		| "started"
		| "ready"
		| "error_detected"
		| "recovered"
		| "exited"
		| "crashed"
		| "output"
		| "port_open"
		| "pattern_match"
		| "port_timeout";
	timestamp: number;
	detail: string;
	data?: Record<string, unknown>;
}

export interface OutputDigest {
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

export interface OutputLine {
	stream: "stdout" | "stderr";
	line: string;
	ts: number;
}

export interface BgProcess {
	id: string;
	label: string;
	command: string;
	cwd: string;
	startedAt: number;
	proc: import("node:child_process").ChildProcess;
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

export interface BgProcessInfo {
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

export interface StartOptions {
	command: string;
	cwd: string;
	label?: string;
	type?: ProcessType;
	readyPattern?: string;
	readyPort?: number;
	readyTimeout?: number;
	group?: string;
	env?: Record<string, string>;
}

export interface GetOutputOptions {
	stream: "stdout" | "stderr" | "both";
	tail?: number;
	filter?: string;
	incremental?: boolean;
}

export interface ProcessManifest {
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

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_BUFFER_LINES = 5000;
export const MAX_EVENTS = 200;
export const DEAD_PROCESS_TTL = 10 * 60 * 1000;
export const PORT_PROBE_TIMEOUT = 500;
export const READY_POLL_INTERVAL = 250;
export const DEFAULT_READY_TIMEOUT = 30000;

// ── Pattern Databases ──────────────────────────────────────────────────────

/** Patterns that indicate a process is ready/listening */
export const READINESS_PATTERNS: RegExp[] = [
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
export const ERROR_PATTERNS: RegExp[] = [
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
export const WARNING_PATTERNS: RegExp[] = [
	/\bwarning\b[\s:[\](]/i,
	/\bWARN(?:ING)?\b/,
	/\bdeprecated\b/i,
	/\bDEPRECATED\b/,
	/⚠️?/,
	/\[WARN\]/,
];

/** Patterns to extract URLs */
export const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Patterns to extract port numbers from "listening" messages */
export const PORT_PATTERN = /(?:port|listening\s+on|:)\s*(\d{2,5})\b/gi;

/** Patterns indicating test results */
export const TEST_RESULT_PATTERNS: RegExp[] = [
	/(\d+)\s+(?:tests?\s+)?passed/i,
	/(\d+)\s+(?:tests?\s+)?failed/i,
	/Tests?:\s+(\d+)\s+passed/i,
	/(\d+)\s+passing/i,
	/(\d+)\s+failing/i,
	/PASS|FAIL/,
];

/** Patterns indicating build completion */
export const BUILD_COMPLETE_PATTERNS: RegExp[] = [
	/build\s+(?:completed|succeeded|finished|done)/i,
	/compiled\s+(?:successfully|with\s+\d+\s+(?:error|warning))/i,
	/✓\s+Built/i,
	/webpack\s+\d+\.\d+/i,
	/bundle\s+(?:is\s+)?ready/i,
];
