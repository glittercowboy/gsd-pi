/**
 * Marketplace Store — manages sources and install/uninstall lifecycle.
 * Currently supports local directory sources. Git/HTTP are stubs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getAgentDir } from '@gsd/pi-coding-agent';
import { scanComponentDir } from './component-loader.js';
import type { Component, ComponentKind } from './component-types.js';

export interface MarketplaceSource {
	name: string;
	type: 'local' | 'git' | 'http';
	url?: string;
	path?: string;
	trust: 'verified' | 'trusted' | 'community' | 'untrusted';
}

export interface SearchResult {
	name: string;
	kind: ComponentKind;
	description: string;
	version?: string;
	source: string;
	dirPath: string;
}

export interface InstallResult {
	success: boolean;
	componentId: string;
	installedPath?: string;
	error?: string;
}

export class MarketplaceStore {
	private sources: MarketplaceSource[] = [];
	private configPath: string;

	constructor(configPath?: string) {
		this.configPath = configPath ?? join(getAgentDir(), 'marketplace-sources.yaml');
		this.loadSources();
	}

	loadSources(): void {
		if (!existsSync(this.configPath)) {
			this.sources = [];
			return;
		}
		try {
			const raw = readFileSync(this.configPath, 'utf-8');
			const parsed = parseYaml(raw);
			this.sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
		} catch {
			this.sources = [];
		}
	}

	saveSources(): void {
		const dir = join(this.configPath, '..');
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.configPath, stringifyYaml({ sources: this.sources }), 'utf-8');
	}

	addSource(source: MarketplaceSource): void {
		// Remove existing with same name first
		this.sources = this.sources.filter(s => s.name !== source.name);
		this.sources.push(source);
		this.saveSources();
	}

	removeSource(name: string): boolean {
		const before = this.sources.length;
		this.sources = this.sources.filter(s => s.name !== name);
		if (this.sources.length < before) {
			this.saveSources();
			return true;
		}
		return false;
	}

	getSources(): MarketplaceSource[] {
		return [...this.sources];
	}

	search(query: string, kind?: ComponentKind): SearchResult[] {
		const results: SearchResult[] = [];
		for (const source of this.sources) {
			if (source.type === 'local' && source.path) {
				const scanResult = scanComponentDir(resolve(source.path), 'plugin');
				for (const comp of scanResult.components) {
					if (kind && comp.kind !== kind) continue;
					const q = query.toLowerCase();
					if (comp.metadata.name.includes(q) || comp.metadata.description.toLowerCase().includes(q)) {
						results.push({
							name: comp.id,
							kind: comp.kind,
							description: comp.metadata.description,
							version: comp.metadata.version,
							source: source.name,
							dirPath: comp.dirPath,
						});
					}
				}
			}
		}
		return results;
	}

	install(reference: string, options?: { scope?: 'user' | 'project'; cwd?: string }): InstallResult {
		const scope = options?.scope ?? 'user';

		// Search across all sources for the component
		const allResults = this.search(reference);
		const match = allResults.find(r => r.name === reference) ?? allResults[0];

		if (!match) {
			return { success: false, componentId: reference, error: `Component "${reference}" not found in any source` };
		}

		// Check the source type
		const sourceConfig = this.sources.find(s => s.name === match.source);
		if (sourceConfig && sourceConfig.type !== 'local') {
			return { success: false, componentId: reference, error: `${sourceConfig.type} source support coming soon` };
		}

		// Determine install directory
		let installBase: string;
		if (scope === 'project') {
			const cwd = options?.cwd ?? process.cwd();
			installBase = join(cwd, '.gsd', match.kind === 'agent' ? 'agents' : 'skills');
		} else {
			installBase = join(getAgentDir(), match.kind === 'agent' ? 'agents' : 'skills');
		}

		const installDir = join(installBase, match.name);

		if (existsSync(installDir)) {
			return { success: false, componentId: match.name, error: `Already installed at ${installDir}` };
		}

		try {
			mkdirSync(installBase, { recursive: true });
			cpSync(match.dirPath, installDir, { recursive: true });
			return { success: true, componentId: match.name, installedPath: installDir };
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'copy failed';
			return { success: false, componentId: match.name, error: msg };
		}
	}

	uninstall(componentId: string, options?: { scope?: 'user' | 'project'; cwd?: string }): boolean {
		const scope = options?.scope ?? 'user';

		// Check both skills and agents directories
		const kindDirs = ['skills', 'agents'];
		for (const kindDir of kindDirs) {
			let base: string;
			if (scope === 'project') {
				const cwd = options?.cwd ?? process.cwd();
				base = join(cwd, '.gsd', kindDir);
			} else {
				base = join(getAgentDir(), kindDir);
			}

			const target = join(base, componentId);
			if (existsSync(target)) {
				try {
					rmSync(target, { recursive: true, force: true });
					return true;
				} catch {
					return false;
				}
			}
		}

		return false;
	}
}
