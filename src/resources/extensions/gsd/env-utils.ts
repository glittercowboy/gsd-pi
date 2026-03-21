// GSD Extension — Environment variable utilities
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Pure utility for checking existing env keys in .env files and process.env.
// Extracted from get-secrets-from-user.ts to avoid pulling in @gsd/pi-tui
// when only env-checking is needed (e.g. from files.ts during report generation).

import { readFile } from "node:fs/promises";

/**
 * Check which keys already exist in a .env file or process.env.
 * Returns the subset of `keys` that are already set.
 */
export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
	let fileContent = "";
	try {
		fileContent = await readFile(envFilePath, "utf8");
	} catch {
		// ENOENT or other read error — proceed with empty content
	}

	const existing: string[] = [];
	for (const key of keys) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`^${escaped}\\s*=`, "m");
		if (regex.test(fileContent) || key in process.env) {
			existing.push(key);
		}
	}
	return existing;
}
