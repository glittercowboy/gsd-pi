/**
 * Cross-platform path display for LLM-visible text.
 *
 * Paths injected into prompts, tool results, or extension messages must use
 * forward slashes. Windows backslash paths cause bash failures when the model
 * copies them into shell commands — bash interprets backslashes as escape chars.
 *
 * Use this ONLY for paths entering text the LLM or shell sees.
 * Filesystem operations (fs.readFile, path.join, spawn cwd) handle native
 * separators correctly and should NOT be normalized.
 */

/**
 * Convert a filesystem path to forward-slash form for display in LLM text.
 * No-op on Unix. On Windows converts `C:\Users\name` to `C:/Users/name`.
 */
export function toPosixPath(fsPath: string): string {
  return fsPath.replaceAll("\\", "/");
}
