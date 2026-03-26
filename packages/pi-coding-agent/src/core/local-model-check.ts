/**
 * local-model-check.ts — Utility to detect if a model baseUrl is local.
 *
 * Leaf module with zero transitive dependencies on TypeScript parameter properties.
 * Used by ModelRegistry and tests.
 */

/**
 * Check if a model's baseUrl points to a local endpoint.
 * Returns true for localhost, 127.0.0.1, 0.0.0.0, ::1, or unix socket paths.
 * Returns false if baseUrl is empty (cloud provider) or points to a remote host.
 */
export function isLocalModel(model: { baseUrl: string }): boolean {
	const url = model.baseUrl;
	if (!url) return false;

	// Unix socket paths
	if (url.startsWith("unix://") || url.startsWith("unix:")) return true;

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname;
		if (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "0.0.0.0" ||
			hostname === "::1" ||
			hostname === "[::1]"
		) {
			return true;
		}
	} catch {
		// If URL parsing fails, check raw string for local patterns
		if (
			url.includes("localhost") ||
			url.includes("127.0.0.1") ||
			url.includes("0.0.0.0") ||
			url.includes("[::1]")
		) {
			return true;
		}
	}

	return false;
}
