/**
 * Utility functions for the bg-shell extension.
 */

import { createRequire } from "node:module";

// ── Windows VT Input Restoration ────────────────────────────────────────────
// Child processes (esp. Git Bash / MSYS2) can strip the ENABLE_VIRTUAL_TERMINAL_INPUT
// flag from the shared stdin console handle. Re-enable it after each child exits.

let _vtHandles: { GetConsoleMode: Function; SetConsoleMode: Function; handle: unknown } | null = null;
export function restoreWindowsVTInput(): void {
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

// ── Time Formatting ────────────────────────────────────────────────────────

export function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatTimeAgo(timestamp: number): string {
	return formatUptime(Date.now() - timestamp) + " ago";
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
