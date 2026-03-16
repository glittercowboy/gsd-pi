/**
 * Disk-based cache for discovered models.
 * Stores results at {agentDir}/discovery-cache.json with per-provider TTLs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../config.js";
import { type DiscoveredModel, getDefaultTTL } from "./model-discovery.js";

export interface DiscoveryCacheEntry {
	models: DiscoveredModel[];
	fetchedAt: number;
	ttlMs: number;
}

export interface DiscoveryCacheData {
	version: 1;
	entries: Record<string, DiscoveryCacheEntry>;
}

export class ModelDiscoveryCache {
	private data: DiscoveryCacheData;
	private cachePath: string;

	constructor(cachePath?: string) {
		this.cachePath = cachePath ?? join(getAgentDir(), "discovery-cache.json");
		this.data = { version: 1, entries: {} };
		this.load();
	}

	get(provider: string): DiscoveryCacheEntry | undefined {
		const entry = this.data.entries[provider];
		return entry;
	}

	set(provider: string, models: DiscoveredModel[], ttlMs?: number): void {
		this.data.entries[provider] = {
			models,
			fetchedAt: Date.now(),
			ttlMs: ttlMs ?? getDefaultTTL(provider),
		};
		this.save();
	}

	isStale(provider: string): boolean {
		const entry = this.data.entries[provider];
		if (!entry) return true;
		return Date.now() - entry.fetchedAt > entry.ttlMs;
	}

	clear(provider?: string): void {
		if (provider) {
			delete this.data.entries[provider];
		} else {
			this.data.entries = {};
		}
		this.save();
	}

	getAll(includeStale = false): Map<string, DiscoveryCacheEntry> {
		const result = new Map<string, DiscoveryCacheEntry>();
		for (const [provider, entry] of Object.entries(this.data.entries)) {
			if (includeStale || !this.isStale(provider)) {
				result.set(provider, entry);
			}
		}
		return result;
	}

	load(): void {
		try {
			if (existsSync(this.cachePath)) {
				const content = readFileSync(this.cachePath, "utf-8");
				const parsed = JSON.parse(content) as DiscoveryCacheData;
				if (parsed.version === 1 && parsed.entries) {
					this.data = parsed;
				}
			}
		} catch {
			// Corrupted or unreadable cache — start fresh
			this.data = { version: 1, entries: {} };
		}
	}

	save(): void {
		try {
			const dir = dirname(this.cachePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.cachePath, JSON.stringify(this.data, null, 2), "utf-8");
		} catch {
			// Silently ignore write failures (read-only FS, permissions, etc.)
		}
	}
}
