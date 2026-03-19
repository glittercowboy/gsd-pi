/**
 * Creates a lazy, cached async loader for a dynamically-imported module export.
 *
 * Many provider files need to defer heavy SDK imports until first use to keep
 * startup fast.  This helper eliminates the repeated boilerplate of
 * "cached-variable + async getter that does `await import(…)` and stores the
 * result."
 *
 * @param moduleSpecifier - The module to import (e.g. `"openai"`).
 * @param extract - Optional function that pulls the desired export out of the
 *   module namespace.  Defaults to `(mod) => mod.default` (the default
 *   export).
 * @returns An async function that resolves to the extracted value, caching it
 *   after the first call.
 *
 * @example
 * ```ts
 * import type Anthropic from "@anthropic-ai/sdk";
 * const getAnthropic = lazyImport<typeof Anthropic>("@anthropic-ai/sdk");
 *
 * import type { GoogleGenAI } from "@google/genai";
 * const getGoogleGenAI = lazyImport<typeof GoogleGenAI>(
 *   "@google/genai",
 *   (mod) => mod.GoogleGenAI,
 * );
 * ```
 */
export function lazyImport<T>(
	moduleSpecifier: string,
	extract: (mod: any) => T = (mod) => mod.default,
): () => Promise<T> {
	let cached: T | undefined;
	return async () => {
		if (!cached) {
			const mod = await import(moduleSpecifier);
			cached = extract(mod);
		}
		return cached;
	};
}
