/**
 * Utility functions for the bg-shell extension.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

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

import { formatDuration } from "../shared/mod.js";

export const formatUptime = formatDuration;

export function formatTimeAgo(timestamp: number): string {
	return formatDuration(Date.now() - timestamp) + " ago";
}

function deriveProjectRootFromAutoWorktree(cachedCwd?: string): string | undefined {
	if (!cachedCwd) return undefined;
	const match = cachedCwd.match(/^(.*?)[\\/]\.gsd[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/);
	return match?.[1];
}

export function getBgShellLiveCwd(
	cachedCwd?: string,
	pathExists: (path: string) => boolean = existsSync,
	getCwd: () => string = () => process.cwd(),
	chdir: (path: string) => void = (path) => process.chdir(path),
): string {
	try {
		return getCwd();
	} catch {
		const projectRoot = deriveProjectRootFromAutoWorktree(cachedCwd);
		const home = process.env.HOME || process.env.USERPROFILE;
		const fallbacks = [projectRoot, cachedCwd, home, "/"].filter(
			(candidate): candidate is string => Boolean(candidate),
		);

		for (const candidate of fallbacks) {
			if (candidate !== "/" && !pathExists(candidate)) continue;
			try {
				chdir(candidate);
			} catch {
				// Best-effort only. Returning a known-good fallback is enough to avoid crashes.
			}
			return candidate;
		}

		return "/";
	}
}

export function resolveBgShellPersistenceCwd(
	cachedCwd: string,
	liveCwd: string | undefined = undefined,
	pathExists: (path: string) => boolean = existsSync,
): string {
	const resolvedLiveCwd = liveCwd ?? getBgShellLiveCwd(cachedCwd, pathExists);
	const cachedIsAutoWorktree = /(?:^|[\\/])\.gsd[\\/]worktrees[\\/]/.test(cachedCwd);
	if (!cachedIsAutoWorktree) return cachedCwd;
	if (cachedCwd === resolvedLiveCwd && pathExists(cachedCwd)) return cachedCwd;
	if (!pathExists(cachedCwd)) return resolvedLiveCwd;
	if (resolvedLiveCwd !== cachedCwd) return resolvedLiveCwd;
	return cachedCwd;
}
