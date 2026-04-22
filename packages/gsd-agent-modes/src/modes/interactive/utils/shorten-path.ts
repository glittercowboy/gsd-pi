import * as os from "node:os";

/**
 * Convert absolute path to tilde notation if it's in home directory.
 * Returns empty string for non-string or empty inputs.
 */
export function shortenPath(path: unknown): string {
	if (typeof path !== "string" || !path) return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}
