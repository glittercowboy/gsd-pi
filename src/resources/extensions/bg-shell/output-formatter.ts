/**
 * Output analysis, digest generation, highlights extraction, and output retrieval.
 */

import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@gsd/pi-coding-agent";
import type { BgProcess, OutputDigest, OutputLine, GetOutputOptions } from "./types.js";
import {
	ERROR_PATTERNS,
	WARNING_PATTERNS,
	URL_PATTERN,
	PORT_PATTERN,
	READINESS_PATTERNS,
	BUILD_COMPLETE_PATTERNS,
	TEST_RESULT_PATTERNS,
} from "./types.js";
import { addEvent, pushAlert } from "./process-manager.js";
import { transitionToReady } from "./readiness-detector.js";
import { formatUptime, formatTimeAgo } from "./utilities.js";

// ── Output Analysis ────────────────────────────────────────────────────────

export function analyzeLine(bg: BgProcess, line: string, stream: "stdout" | "stderr"): void {
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

// ── Digest Generation ──────────────────────────────────────────────────────

export function generateDigest(bg: BgProcess, mutate: boolean = false): OutputDigest {
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

export function getHighlights(bg: BgProcess, maxLines: number = 15): string[] {
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

// ── Output Retrieval (multi-tier) ──────────────────────────────────────────

export function getOutput(bg: BgProcess, opts: GetOutputOptions): string {
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

// ── Format Digest for LLM ──────────────────────────────────────────────────

export function formatDigestText(bg: BgProcess, digest: OutputDigest): string {
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
