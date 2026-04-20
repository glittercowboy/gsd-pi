// GSD-2 — Extension Manifest: Types and reading for extension-manifest.json
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtensionManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	tier: "core" | "bundled" | "community";
	requires: { platform: string };
	provides?: {
		tools?: string[];
		commands?: string[];
		hooks?: string[];
		shortcuts?: string[];
	};
	dependencies?: {
		extensions?: string[];
		runtime?: string[];
	};
}

// ─── Validation ─────────────────────────────────────────────────────────────

function isManifest(data: unknown): data is ExtensionManifest {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.id === "string" &&
		typeof obj.name === "string" &&
		typeof obj.version === "string" &&
		typeof obj.tier === "string"
	);
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Read extension-manifest.json from a directory. Returns null if missing or invalid. */
export function readManifest(extensionDir: string): ExtensionManifest | null {
	const manifestPath = join(extensionDir, "extension-manifest.json");
	if (!existsSync(manifestPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
		return isManifest(raw) ? raw : null;
	} catch {
		return null;
	}
}

/**
 * Given an entry path (e.g. `.../extensions/browser-tools/index.ts`),
 * resolve the parent directory and read its manifest.
 */
export function readManifestFromEntryPath(entryPath: string): ExtensionManifest | null {
	const dir = dirname(entryPath);
	return readManifest(dir);
}
