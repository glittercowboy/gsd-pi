/**
 * Unified Component Registry
 *
 * Single registry that handles discovery, resolution, and lifecycle for all
 * component types (skills, agents, pipelines, agent-teams).
 *
 * Consolidates the separate discovery systems:
 * - pi-coding-agent/core/skills.ts (loadSkills)
 * - extensions/subagent/agents.ts (discoverAgents)
 * - extensions/gsd/namespaced-registry.ts (NamespacedRegistry)
 *
 * Resolution precedence:
 * 1. Project-local — .gsd/components/ or .pi/skills/ or .pi/agents/
 * 2. User-global — ~/.gsd/components/ or ~/.gsd/agent/skills/ or ~/.gsd/agent/agents/
 * 3. Builtin — bundled with GSD
 * 4. Namespace-qualified — gsd:security-audit
 * 5. Shorthand — security-audit (unique match required)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAgentDir, parseFrontmatter } from '@gsd/pi-coding-agent';

/** Project-local config directory name. Matches piConfig.configDir in package.json. */
const CONFIG_DIR_NAME = '.gsd';
import type {
	Component,
	ComponentDiagnostic,
	ComponentFilter,
	ComponentKind,
	ComponentSource,
} from './component-types.js';
import { computeComponentId } from './component-types.js';
import {
	scanComponentDir,
	scanAgentDir,
	loadComponentFromDir,
	type LoadComponentsResult,
} from './component-loader.js';

// ============================================================================
// Registry
// ============================================================================

export class ComponentRegistry {
	/** Primary storage: component ID → Component */
	private components = new Map<string, Component>();

	/** All diagnostics from loading */
	private diagnostics: ComponentDiagnostic[] = [];

	/** Whether the registry has been loaded */
	private loaded = false;

	/** Working directory for project-local discovery */
	private cwd: string;

	constructor(cwd?: string) {
		this.cwd = cwd ?? process.cwd();
	}

	// ========================================================================
	// Loading
	// ========================================================================

	/**
	 * Load all components from all configured locations.
	 * Skills and agents from both legacy and new format locations.
	 */
	load(): void {
		this.components.clear();
		this.diagnostics = [];
		this.loaded = true;

		const agentDir = getAgentDir();

		// 1. User-global skills (legacy: ~/.gsd/agent/skills/)
		this.addFromDir(join(agentDir, 'skills'), 'user', 'skill');

		// 2. User-global agents (legacy: ~/.gsd/agent/agents/)
		this.addAgentsFromDir(join(agentDir, 'agents'), 'user');

		// 3. Project-local skills (legacy: .pi/skills/)
		const projectSkillsDir = resolve(this.cwd, CONFIG_DIR_NAME, 'skills');
		this.addFromDir(projectSkillsDir, 'project', 'skill');

		// 4. Project-local agents (legacy: .pi/agents/ - walk up directory tree)
		const projectAgentsDir = this.findNearestDir(this.cwd, CONFIG_DIR_NAME, 'agents');
		if (projectAgentsDir) {
			this.addAgentsFromDir(projectAgentsDir, 'project');
		}

		// 5. User-global components (new: ~/.gsd/components/)
		const userComponentsDir = join(agentDir, 'components');
		if (existsSync(userComponentsDir)) {
			this.addNewFormatComponents(userComponentsDir, 'user');
		}

		// 6. Project-local components (new: .gsd/components/ or .pi/components/)
		const projectComponentsDir = resolve(this.cwd, CONFIG_DIR_NAME, 'components');
		if (existsSync(projectComponentsDir)) {
			this.addNewFormatComponents(projectComponentsDir, 'project');
		}
	}

	/**
	 * Reload the registry (re-scan all directories).
	 */
	reload(): void {
		this.load();
	}

	// ========================================================================
	// Querying
	// ========================================================================

	/**
	 * Get a component by ID (exact match).
	 */
	get(id: string): Component | undefined {
		this.ensureLoaded();
		return this.components.get(id);
	}

	/**
	 * Resolve a component reference.
	 * Tries: exact ID → namespace:name → shorthand (unique bare name match).
	 */
	resolve(reference: string): Component | undefined {
		this.ensureLoaded();

		// 1. Exact ID match
		const exact = this.components.get(reference);
		if (exact) return exact;

		// 2. If reference contains ':', it's namespace-qualified — already tried
		if (reference.includes(':')) return undefined;

		// 3. Shorthand: find all components with matching bare name
		const matches: Component[] = [];
		for (const comp of this.components.values()) {
			if (comp.metadata.name === reference) {
				matches.push(comp);
			}
		}

		if (matches.length === 1) return matches[0];
		// Ambiguous or not found
		return undefined;
	}

	/**
	 * Get all components matching a filter.
	 */
	list(filter?: ComponentFilter): Component[] {
		this.ensureLoaded();

		let results = Array.from(this.components.values());

		// Filter by enabled (default: true — only show enabled components)
		if (!filter || filter.enabledOnly !== false) {
			results = results.filter(c => c.enabled);
		}

		if (!filter) return results;

		// Filter by kind
		if (filter.kind) {
			const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
			results = results.filter(c => kinds.includes(c.kind));
		}

		// Filter by source
		if (filter.source) {
			const sources = Array.isArray(filter.source) ? filter.source : [filter.source];
			results = results.filter(c => sources.includes(c.source));
		}

		// Filter by namespace
		if (filter.namespace !== undefined) {
			results = results.filter(c => c.metadata.namespace === filter.namespace);
		}

		// Filter by tags
		if (filter.tags && filter.tags.length > 0) {
			results = results.filter(c =>
				c.metadata.tags?.some(t => filter.tags!.includes(t))
			);
		}

		// Text search
		if (filter.search) {
			const q = filter.search.toLowerCase();
			results = results.filter(c =>
				c.metadata.name.toLowerCase().includes(q) ||
				c.metadata.description.toLowerCase().includes(q)
			);
		}

		return results;
	}

	/**
	 * Get all skills.
	 */
	skills(): Component[] {
		return this.list({ kind: 'skill' });
	}

	/**
	 * Get all agents.
	 */
	agents(): Component[] {
		return this.list({ kind: 'agent' });
	}

	/**
	 * Get all pipelines.
	 */
	pipelines(): Component[] {
		return this.list({ kind: 'pipeline' });
	}

	/**
	 * Check if a component exists.
	 */
	has(id: string): boolean {
		this.ensureLoaded();
		return this.components.has(id);
	}

	/**
	 * Get the total number of components.
	 */
	get size(): number {
		this.ensureLoaded();
		return this.components.size;
	}

	/**
	 * Get all diagnostics from loading.
	 */
	getDiagnostics(): ComponentDiagnostic[] {
		return [...this.diagnostics];
	}

	// ========================================================================
	// Mutation
	// ========================================================================

	/**
	 * Register a component directly (for plugins, marketplace imports, etc.).
	 */
	register(component: Component): ComponentDiagnostic | undefined {
		const existing = this.components.get(component.id);
		if (existing) {
			const diagnostic: ComponentDiagnostic = {
				type: 'collision',
				message: `component "${component.id}" collision`,
				componentId: component.id,
				path: component.filePath,
				collision: {
					name: component.metadata.name,
					winnerPath: existing.filePath,
					loserPath: component.filePath,
					winnerSource: existing.source,
					loserSource: component.source,
				},
			};
			this.diagnostics.push(diagnostic);
			return diagnostic;
		}

		this.components.set(component.id, component);
		return undefined;
	}

	/**
	 * Remove a component by ID.
	 */
	remove(id: string): boolean {
		return this.components.delete(id);
	}

	/**
	 * Enable or disable a component.
	 */
	setEnabled(id: string, enabled: boolean): boolean {
		const component = this.components.get(id);
		if (!component) return false;
		component.enabled = enabled;
		return true;
	}

	// ========================================================================
	// Bridge Methods (backward compatibility)
	// ========================================================================

	/**
	 * Get skills in the legacy Skill format for system prompt integration.
	 * Used by the existing skill-discovery and formatSkillsForPrompt systems.
	 */
	getSkillsForPrompt(): Array<{
		name: string;
		description: string;
		filePath: string;
		baseDir: string;
		source: string;
		disableModelInvocation: boolean;
	}> {
		return this.skills().map(c => ({
			name: c.metadata.name,
			description: c.metadata.description,
			filePath: c.filePath,
			baseDir: c.dirPath,
			source: c.source,
			disableModelInvocation:
				c.kind === 'skill' && (c.spec as { disableModelInvocation?: boolean }).disableModelInvocation === true,
		}));
	}

	/**
	 * Get agents in the legacy AgentConfig format for subagent integration.
	 * Used by the existing subagent system.
	 */
	getAgentsForSubagent(): Array<{
		name: string;
		description: string;
		tools?: string[];
		model?: string;
		systemPrompt: string;
		source: 'user' | 'project';
		filePath: string;
	}> {
		return this.agents().map(c => {
			const agentSpec = c.spec as {
				tools?: { allow?: string[] } | string[];
				model?: string;
				systemPrompt?: string;
			};

			// Read the system prompt content
			let systemPrompt = '';
			const promptFile = agentSpec.systemPrompt || 'AGENT.md';
			const promptPath = join(c.dirPath, promptFile);
			try {
				const { body } = parseFrontmatterSafe(promptPath);
				systemPrompt = body;
			} catch {
				systemPrompt = '';
			}

			// Normalize tools
			let tools: string[] | undefined;
			if (Array.isArray(agentSpec.tools)) {
				tools = agentSpec.tools;
			} else if (agentSpec.tools && 'allow' in agentSpec.tools) {
				tools = agentSpec.tools.allow;
			}

			return {
				name: c.metadata.name,
				description: c.metadata.description,
				tools,
				model: agentSpec.model,
				systemPrompt,
				source: c.source as 'user' | 'project',
				filePath: c.filePath,
			};
		});
	}

	// ========================================================================
	// Internal
	// ========================================================================

	private ensureLoaded(): void {
		if (!this.loaded) {
			this.load();
		}
	}

	private addFromDir(dir: string, source: ComponentSource, kind?: ComponentKind): void {
		const result = scanComponentDir(dir, source, kind);
		this.mergeResults(result, source);
	}

	private addAgentsFromDir(dir: string, source: ComponentSource): void {
		const result = scanAgentDir(dir, source);
		this.mergeResults(result, source);
	}

	private addNewFormatComponents(baseDir: string, source: ComponentSource): void {
		// Scan subdirectories: components/skills/, components/agents/, components/pipelines/
		for (const subdir of ['skills', 'agents', 'pipelines', 'agent-teams']) {
			const dir = join(baseDir, subdir);
			if (existsSync(dir)) {
				const result = scanComponentDir(dir, source);
				this.mergeResults(result, source);
			}
		}

		// Also scan the base directory directly for flat components
		const result = scanComponentDir(baseDir, source);
		this.mergeResults(result, source);
	}

	private mergeResults(result: LoadComponentsResult, _source: ComponentSource): void {
		this.diagnostics.push(...result.diagnostics);
		for (const component of result.components) {
			this.register(component);
		}
	}

	private findNearestDir(startDir: string, ...segments: string[]): string | null {
		let currentDir = startDir;
		while (true) {
			const candidate = join(currentDir, ...segments);
			if (existsSync(candidate)) {
				try {
					const stat = statSync(candidate);
					if (stat.isDirectory()) return candidate;
				} catch {
					// ignore
				}
			}

			const parentDir = resolve(currentDir, '..');
			if (parentDir === currentDir) return null;
			currentDir = parentDir;
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function parseFrontmatterSafe(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
	try {
		const raw = readFileSync(filePath, 'utf-8');
		return parseFrontmatter<Record<string, unknown>>(raw);
	} catch {
		return { frontmatter: {}, body: '' };
	}
}

// ============================================================================
// Singleton
// ============================================================================

let _registry: ComponentRegistry | null = null;

/**
 * Get the global component registry singleton.
 * Lazily initialized on first access.
 */
export function getComponentRegistry(cwd?: string): ComponentRegistry {
	if (!_registry || (cwd && cwd !== (_registry as any).cwd)) {
		_registry = new ComponentRegistry(cwd);
	}
	return _registry;
}

/**
 * Reset the global registry (for testing).
 */
export function resetComponentRegistry(): void {
	_registry = null;
}
