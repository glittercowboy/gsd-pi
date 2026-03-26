/**
 * TUI: Background Process Manager Overlay.
 */

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import type { BgProcess, ProcessStatus } from "./types.js";
import { ERROR_PATTERNS, WARNING_PATTERNS } from "./types.js";
import { formatUptime, formatTimeAgo } from "./utilities.js";
import {
	processes,
	killProcess,
	cleanupAll,
	restartProcess,
} from "./process-manager.js";

export class BgManagerOverlay {
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
				}).catch((err) => {
					if (process.env.GSD_DEBUG) console.error('[bg-shell] restart failed:', err);
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

	private processStatusHeader(p: typeof this.viewingProcess, activeTab: "output" | "events"): { statusIcon: string; headerLine: string } {
		const th = this.theme;
		if (!p) return { statusIcon: "", headerLine: "" };
		const statusIcon = p.alive
			? (p.status === "ready" ? th.fg("success", "●")
				: p.status === "error" ? th.fg("error", "●")
				: th.fg("warning", "●"))
			: th.fg("dim", "○");
		const name = th.fg("muted", p.label);
		const uptime = th.fg("dim", formatUptime(Date.now() - p.startedAt));
		const typeTag = th.fg("dim", `[${p.processType}]`);
		const portInfo = p.ports.length > 0 ? th.fg("dim", ` :${p.ports.join(",")}`) : "";
		const tabIndicator = activeTab === "output"
			? th.fg("accent", "[Output]") + " " + th.fg("dim", "Events")
			: th.fg("dim", "Output") + " " + th.fg("accent", "[Events]");
		const headerLine = `${statusIcon} ${name} ${typeTag} ${uptime}${portInfo}  ${tabIndicator}`;
		return { statusIcon, headerLine };
	}

	private renderOutput(width: number): string[] {
		const th = this.theme;
		const p = this.viewingProcess;
		if (!p) return [""];
		const inner: string[] = [];

		const { headerLine } = this.processStatusHeader(p, "output");
		inner.push(headerLine);
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

		const { headerLine } = this.processStatusHeader(p, "events");
		inner.push(headerLine);
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

	dispose(): void {
		clearInterval(this.refreshTimer);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
