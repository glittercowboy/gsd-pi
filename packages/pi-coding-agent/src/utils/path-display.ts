/**
 * Cross-platform path display utilities.
 *
 * Paths injected into LLM prompts, tool results, or any text the model
 * processes must use forward slashes. Windows backslash paths cause bash
 * failures when the model copies them into shell commands — bash interprets
 * backslashes as escape characters, silently stripping them.
 *
 * Node's `path` module and `fs` module handle native separators correctly
 * for filesystem operations. This module is ONLY for paths that enter
 * text consumed by the LLM or interpreted by a shell.
 *
 * Usage:
 *   import { toPosixPath } from "./path-display.js";
 *   prompt += `Current working directory: ${toPosixPath(cwd)}`;
 *
 * NOT for:
 *   fs.readFile(path)          — use native path as-is
 *   path.join(a, b)            — use native path module
 *   spawn(cmd, { cwd: path })  — Node handles this correctly
 */

/**
 * Convert a filesystem path to forward-slash (POSIX) form for display.
 *
 * On Unix this is a no-op. On Windows it converts `C:\Users\name\project`
 * to `C:/Users/name/project`, which is valid in:
 * - Git Bash / MSYS2
 * - WSL bash
 * - PowerShell
 * - Node.js APIs (which accept both separators)
 * - Most Windows programs
 */
export function toPosixPath(fsPath: string): string {
	return fsPath.replaceAll("\\", "/");
}
