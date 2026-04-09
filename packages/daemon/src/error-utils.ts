// GSD2 — Daemon error utility
/**
 * Extract a human-readable message from an unknown caught value.
 */
export function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
