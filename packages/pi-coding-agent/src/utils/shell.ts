import { existsSync } from "node:fs";
import { release } from "node:os";
import { delimiter } from "node:path";
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "child_process";
import { getBinDir, getSettingsPath } from "../config.js";
import { SettingsManager } from "../core/settings-manager.js";

let cachedShellConfig: { shell: string; args: string[] } | null = null;

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(): { shell: string; args: string[] } {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	const settings = SettingsManager.create();
	const customShellPath = settings.getShellPath();

	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			cachedShellConfig = { shell: customShellPath, args: ["-c"] };
			return cachedShellConfig;
		}
		throw new Error(
			`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ${getSettingsPath()}`,
		);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				cachedShellConfig = { shell: path, args: ["-c"] };
				return cachedShellConfig;
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Option/mnt/s/n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				`  3. Set shellPath in ${getSettingsPath()}\n\n` +
				`Searched Git Bash i/mnt/n/n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		cachedShellConfig = { shell: "/bin/bash", args: ["-c"] };
		return cachedShellConfig;
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
		return cachedShellConfig;
	}

	cachedShellConfig = { shell: "sh", args: ["-c"] };
	return cachedShellConfig;
}

/**
 * Get a fallback shell configuration for Windows when bash spawning fails.
 * Tries PowerShell Core, Windows PowerShell, and cmd.exe in order.
 * Returns null on non-Windows or if no fallback works.
 */
export function getFallbackShellConfig(): { shell: string; args: string[] } | null {
	if (process.platform !== "win32") return null;

	const candidates: Array<{ shell: string; args: string[]; testArgs: string[] }> = [
		{ shell: "pwsh.exe", args: ["-NoProfile", "-Command"], testArgs: ["-NoProfile", "-Command", "echo ok"] },
		{ shell: "powershell.exe", args: ["-NoProfile", "-Command"], testArgs: ["-NoProfile", "-Command", "echo ok"] },
		{ shell: "cmd.exe", args: ["/c"], testArgs: ["/c", "echo ok"] },
	];

	for (const candidate of candidates) {
		try {
			const result = spawnSync(candidate.shell, candidate.testArgs, {
				encoding: "utf-8",
				timeout: 5000,
				stdio: "pipe",
			});
			if (result.status === 0) {
				return { shell: candidate.shell, args: candidate.args };
			}
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Format diagnostic information for spawn errors.
 * Helps users and maintainers understand what went wrong.
 */
export function formatSpawnDiagnostics(shell: string, cwd?: string): string {
	const shellExists = (() => {
		try { return existsSync(shell); } catch { return "unknown"; }
	})();

	return [
		`Shell: ${shell} (exists: ${shellExists})`,
		`CWD: ${cwd ?? process.cwd()}`,
		`Node: ${process.version}`,
		`Platform: ${process.platform} ${process.arch}`,
		`OS: ${release()}`,
		`Hint: Set shellPath in settings (${getSettingsPath()}) to override shell resolution`,
	].join("\n  ");
}

/**
 * Spawn a child process with EINVAL resilience on Windows.
 *
 * On Windows, spawn() can fail with EINVAL for multiple reasons beyond the
 * known detached:true / CREATE_NEW_PROCESS_GROUP cause (which is already
 * guarded). Additional triggers include Node.js version regressions,
 * ConPTY changes in recent Windows builds, and specific terminal contexts.
 *
 * This wrapper catches synchronous EINVAL errors and retries with fallback
 * shell configurations (cmd.exe, PowerShell) to keep the session functional.
 */
export function spawnWithEinvalRecovery(
	file: string,
	args: readonly string[],
	options: SpawnOptions,
): ChildProcess {
	try {
		return spawn(file, args as string[], options);
	} catch (err: any) {
		if (err?.code === "EINVAL" && process.platform === "win32") {
			// Retry 1: same shell but wrapped via cmd.exe (shell: true)
			try {
				return spawn(file, args as string[], { ...options, shell: true });
			} catch {
				// Retry 2: use a Windows-native fallback shell entirely
				const fallback = getFallbackShellConfig();
				if (fallback) {
					// The last arg is the command — extract it and rewrap
					const command = args[args.length - 1];
					return spawn(fallback.shell, [...fallback.args, command as string], {
						...options,
						shell: false,
					});
				}
			}

			// All retries exhausted — throw with diagnostics
			const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
			throw new Error(
				`spawn EINVAL: All shell fallbacks exhausted on Windows.\n` +
				`  ${formatSpawnDiagnostics(file, cwd)}\n\n` +
				`Possible cause/mnt/s/n` +
				`  - Node.js ${process.version} spawn regression on Windows\n` +
				`  - ConPTY conflict with terminal host (Windows ${release()})\n` +
				`  - Shell binary inaccessible or corrupted\n\n` +
				`Workaround: Set shellPath to cmd.exe or powershell.exe in ${getSettingsPath()}`,
			);
		}
		throw err;
	}
}

/**
 * On Windows + Git Bash, rewrite Windows-style NUL redirects to /dev/null.
 * Git Bash doesn't recognize NUL as a device name and creates a literal file
 * that is undeletable due to NUL being a reserved Windows device name.
 * No-op on non-Windows platforms.
 */
export function sanitizeCommand(command: string): string {
	if (process.platform !== "win32") return command;
	return command.replace(/(\d*>>?) *\bNUL\b(?=\s|;|\||&|\)|$)/gi, "$1 /dev/null");
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
