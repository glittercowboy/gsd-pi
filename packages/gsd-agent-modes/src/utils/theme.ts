/**
 * Global theme proxy for gsd-agent-modes.
 *
 * Both @gsd/pi-coding-agent module paths (core/theme/theme.ts and
 * modes/interactive/theme/theme.ts) write the active theme to the same
 * globalThis key, but they export two structurally-incompatible Theme classes
 * (different private fields). Importing `theme` from either path triggers TS2345.
 *
 * This module creates its own Proxy using the same Symbol key, bypassing the
 * dual-module-path mismatch. It is typed with the `Theme` class from the
 * barrel index (which exports Theme from modes/interactive/theme/theme.ts).
 */
import type { Theme } from "@gsd/pi-coding-agent";

const THEME_KEY = Symbol.for("@gsd/pi-coding-agent:theme");

/** Global theme proxy — reflects the active theme set by initTheme(). */
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});
