/**
 * Local model detection utilities.
 *
 * Restored from pi-mono 0.57.1 — removed in 0.67.2 but still referenced
 * by GSD tests (offline-mode.test.ts). GSD vendor patch.
 */

/**
 * Returns true if the model is served from a local URL (localhost, loopback, unix socket).
 */
export function isLocalModel(model: { baseUrl?: string }): boolean {
	const url = model.baseUrl;
	if (!url) return false;
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

/**
 * Returns true if all models in the chain are local.
 */
export function isAllLocalChain(models: Array<{ baseUrl?: string }>): boolean {
	return models.length > 0 && models.every(isLocalModel);
}
