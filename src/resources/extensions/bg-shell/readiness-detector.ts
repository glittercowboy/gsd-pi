/**
 * Readiness detection: port probing, pattern matching, wait-for-ready.
 */

import { createConnection } from "node:net";
import type { BgProcess } from "./types.js";
import {
	PORT_PROBE_TIMEOUT,
	READY_POLL_INTERVAL,
	DEFAULT_READY_TIMEOUT,
} from "./types.js";
import { addEvent, pushAlert } from "./process-manager.js";

// ── Readiness Transition ───────────────────────────────────────────────────

export function transitionToReady(bg: BgProcess, detail: string): void {
	bg.status = "ready";
	bg.wasReady = true;
	addEvent(bg, { type: "ready", detail });
}

// ── Port Probing ───────────────────────────────────────────────────────────

export function probePort(port: number, host: string = "127.0.0.1"): Promise<boolean> {
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

// ── Port Probing Loop ──────────────────────────────────────────────────────

export function startPortProbing(bg: BgProcess, port: number, customTimeout?: number): void {
	const timeout = customTimeout || DEFAULT_READY_TIMEOUT;
	const interval = setInterval(async () => {
		if (!bg.alive) {
			clearInterval(interval);
			const stderrLines = bg.output.filter(l => l.stream === "stderr").slice(-10).map(l => l.line);
			const detail = `Process exited (code ${bg.exitCode}) before port ${port} opened${stderrLines.length > 0 ? ` — ${stderrLines.join("; ").slice(0, 200)}` : ""}`;
			addEvent(bg, { type: "port_timeout", detail, data: { port, exitCode: bg.exitCode } });
			return;
		}
		if (bg.status !== "starting") {
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

	// Stop probing after timeout — transition to error state so the process
	// doesn't stay in "starting" forever (fixes #428)
	setTimeout(() => {
		clearInterval(interval);
		if (bg.alive && bg.status === "starting") {
			const stderrLines = bg.output.filter(l => l.stream === "stderr").slice(-10).map(l => l.line);
			const detail = `Port ${port} not open after ${timeout}ms${stderrLines.length > 0 ? ` — ${stderrLines.join("; ").slice(0, 200)}` : ""}`;
			bg.status = "error";
			addEvent(bg, { type: "port_timeout", detail, data: { port, timeout } });
			pushAlert(bg, `Port ${port} readiness timeout after ${timeout / 1000}s`);
		}
	}, timeout);
}

// ── Wait for Ready ─────────────────────────────────────────────────────────

export async function waitForReady(bg: BgProcess, timeout: number, signal?: AbortSignal): Promise<{ ready: boolean; detail: string }> {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		if (signal?.aborted) {
			return { ready: false, detail: "Cancelled" };
		}
		if (!bg.alive) {
			const stderrLines = bg.output.filter(l => l.stream === "stderr").slice(-5).map(l => l.line);
			const stderrContext = stderrLines.length > 0 ? `\nstderr:\n${stderrLines.join("\n").slice(0, 500)}` : "";
			return {
				ready: false,
				detail: `Process exited before becoming ready (code ${bg.exitCode})${bg.recentErrors.length > 0 ? ` — ${bg.recentErrors.slice(-1)[0]}` : ""}${stderrContext}`,
			};
		}
		if (bg.status === "error") {
			const stderrLines = bg.output.filter(l => l.stream === "stderr").slice(-5).map(l => l.line);
			const stderrContext = stderrLines.length > 0 ? `\nstderr:\n${stderrLines.join("\n").slice(0, 500)}` : "";
			return {
				ready: false,
				detail: `Process entered error state${bg.readyPort ? ` (port ${bg.readyPort} never opened)` : ""}${stderrContext}`,
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

	const stderrLines = bg.output.filter(l => l.stream === "stderr").slice(-5).map(l => l.line);
	const stderrContext = stderrLines.length > 0 ? `\nstderr:\n${stderrLines.join("\n").slice(0, 500)}` : "";
	return { ready: false, detail: `Timed out after ${timeout}ms waiting for ready signal${stderrContext}` };
}
