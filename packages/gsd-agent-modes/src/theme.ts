/**
 * GSD theme proxy — re-exports the live theme singleton from pi-coding-agent.
 *
 * The `theme` proxy reads from the same globalThis key that pi-coding-agent's
 * initTheme() sets, so it always reflects the currently active theme without
 * requiring a direct import of the (removed) `theme` value export.
 */

import type { Theme } from "@gsd/agent-types";

// Use the same Symbol key that pi-coding-agent uses for the global theme singleton.
const THEME_KEY = Symbol.for("@gsd/pi-coding-agent:theme");

/**
 * Live proxy to the currently active theme instance.
 * Equivalent to the removed `theme` proxy export from @gsd/pi-coding-agent 0.67.2.
 * Throws if initTheme() has not been called yet.
 */
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});
