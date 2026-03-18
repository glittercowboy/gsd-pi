/**
 * Namespaced Component Registry Module
 *
 * Provides the canonical identity model for imported plugin components.
 * Supports both namespaced (plugin:component) and flat (bare name) components,
 * detects collisions at registration time, and provides lookup by canonical name
 * or namespace listing.
 *
 * This registry serves as the bridge between S01's plugin discovery output
 * and Pi's internal component resolution system.
 */

import type { DiscoveredPlugin } from './marketplace-discovery.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Component type enumeration.
 * Matches the component categories discovered by S01.
 */
export type ComponentType = 'skill' | 'agent';

/**
 * A component entry in the namespaced registry.
 *
 * Components can be:
 * - Namespaced: `${namespace}:${name}` (e.g., "my-plugin:code-review")
 * - Flat: `${name}` (e.g., "code-review" for backward compatibility)
 */
export interface NamespacedComponent {
	/** The component's local name (e.g., "code-review") */
	name: string;

	/** The plugin namespace (e.g., "my-plugin"). Undefined for flat components. */
	namespace: string | undefined;

	/** The computed canonical identifier: `${namespace}:${name}` or bare `name` */
	canonicalName: string;

	/** Component type: skill or agent */
	type: ComponentType;

	/** Absolute path to the component's definition file */
	filePath: string;

	/** Source identifier (e.g., "plugin:my-plugin", "user", "project") */
	source: string;

	/** Optional description from the component's frontmatter */
	description: string | undefined;

	/** Extensible metadata bag for plugin origin info */
	metadata: {
		/** Plugin version if available */
		pluginVersion?: string;
		/** Plugin author if available */
		pluginAuthor?: string;
		/** Plugin homepage if available */
		pluginHomepage?: string;
		/** Plugin category if available */
		pluginCategory?: string;
		/** Original component directory name */
		componentDir?: string;
		/** Additional plugin-specific metadata */
		[key: string]: unknown;
	};
}

/**
 * Collision information for registry diagnostics.
 * Mirrors the ResourceCollision pattern from pi-coding-agent.
 */
export interface RegistryCollision {
	/** The canonical name that collided (e.g., "my-plugin:code-review") */
	canonicalName: string;

	/** Path to the component that won (first registered) */
	winnerPath: string;

	/** Path to the component that lost (subsequent duplicate) */
	loserPath: string;

	/** Source of the winning component */
	winnerSource?: string;

	/** Source of the losing component */
	loserSource?: string;
}

/**
 * Diagnostic entry for registry operations.
 * Currently only reports collisions, but extensible for future diagnostics.
 */
export interface RegistryDiagnostic {
	/** Diagnostic type */
	type: 'collision';

	/** Human-readable message */
	message: string;

	/** Collision details */
	collision: RegistryCollision;
}

/**
 * Result of an alias registration attempt.
 * Successful registrations return success: true.
 * Failed registrations return success: false with a reason.
 */
export interface AliasRegistrationResult {
	/** Whether the registration succeeded */
	success: boolean;

	/** On failure, the reason for rejection */
	reason?: 'canonical-not-found' | 'shadows-canonical' | 'duplicate-alias';

	/** Human-readable message */
	message?: string;
}

// ============================================================================
// NamespacedRegistry Class
// ============================================================================

/**
 * Registry for namespaced plugin components.
 *
 * Features:
 * - Computes canonical names from namespace + name
 * - Detects and reports collisions at registration time
 * - First registration wins; subsequent duplicates return diagnostic
 * - Lookup by canonical name or namespace listing
 * - Compatible with both namespaced and flat (non-namespaced) components
 *
 * Usage:
 * ```typescript
 * const registry = new NamespacedRegistry();
 *
 * // Register a namespaced component
 * const diag = registry.register({
 *   name: 'code-review',
 *   namespace: 'my-plugin',
 *   type: 'skill',
 *   filePath: '/plugins/my-plugin/skills/code-review/SKILL.md',
 *   source: 'plugin:my-plugin',
 *   description: 'Reviews code for quality issues',
 *   metadata: { pluginVersion: '1.0.0' }
 * });
 *
 * // Lookup by canonical name
 * const skill = registry.getByCanonical('my-plugin:code-review');
 *
 * // List all components in a namespace
 * const allSkills = registry.getByNamespace('my-plugin');
 * ```
 */
export class NamespacedRegistry {
	/** Internal storage: canonicalName -> component */
	private components = new Map<string, NamespacedComponent>();

	/** Internal storage: alias -> canonicalName */
	private aliasMap = new Map<string, string>();

	/** Collision diagnostics collected during registration */
	private diagnostics: RegistryDiagnostic[] = [];

	/**
	 * Register a component in the registry.
	 *
	 * Computes the canonical name as `${namespace}:${name}` when namespace is present,
	 * or bare `name` otherwise. Returns a diagnostic if the canonical name already exists.
	 *
	 * @param component - Component data (without canonicalName, which is computed)
	 * @returns Diagnostic if collision detected, undefined otherwise
	 */
	register(component: Omit<NamespacedComponent, 'canonicalName'>): RegistryDiagnostic | undefined {
		// Compute canonical name
		const canonicalName = component.namespace
			? `${component.namespace}:${component.name}`
			: component.name;

		// Create full component with canonical name
		const fullComponent: NamespacedComponent = {
			...component,
			canonicalName,
		};

		// Check for collision
		const existing = this.components.get(canonicalName);
		if (existing) {
			const diagnostic: RegistryDiagnostic = {
				type: 'collision',
				message: `canonical name "${canonicalName}" collision`,
				collision: {
					canonicalName,
					winnerPath: existing.filePath,
					loserPath: component.filePath,
					winnerSource: existing.source,
					loserSource: component.source,
				},
			};
			this.diagnostics.push(diagnostic);
			return diagnostic;
		}

		// Register the component
		this.components.set(canonicalName, fullComponent);
		return undefined;
	}

	/**
	 * Get a component by its canonical name.
	 *
	 * @param canonicalName - The canonical name (e.g., "my-plugin:code-review" or "code-review")
	 * @returns The component if found, undefined otherwise
	 */
	getByCanonical(canonicalName: string): NamespacedComponent | undefined {
		return this.components.get(canonicalName);
	}

	/**
	 * Get all components belonging to a specific namespace.
	 *
	 * @param namespace - The namespace to filter by (e.g., "my-plugin")
	 * @returns Array of components in that namespace
	 */
	getByNamespace(namespace: string): NamespacedComponent[] {
		const results: NamespacedComponent[] = [];
		for (const component of this.components.values()) {
			if (component.namespace === namespace) {
				results.push(component);
			}
		}
		return results;
	}

	/**
	 * Get all registered components.
	 *
	 * @returns Array of all components
	 */
	getAll(): NamespacedComponent[] {
		return Array.from(this.components.values());
	}

	/**
	 * Get all diagnostics collected during registration.
	 *
	 * Returns deep copies to prevent external mutation of internal state.
	 *
	 * @returns Array of diagnostics (collisions, etc.)
	 */
	getDiagnostics(): RegistryDiagnostic[] {
		return this.diagnostics.map((d) => ({
			type: d.type,
			message: d.message,
			collision: { ...d.collision },
		}));
	}

	/**
	 * Check if a canonical name is already registered.
	 *
	 * @param canonicalName - The canonical name to check
	 * @returns true if registered, false otherwise
	 */
	has(canonicalName: string): boolean {
		return this.components.has(canonicalName);
	}

	/**
	 * Get the count of registered components.
	 *
	 * @returns Number of components
	 */
	get size(): number {
		return this.components.size;
	}

	// ============================================================================
	// Alias Management
	// ============================================================================

	/**
	 * Register an alias for a canonical name.
	 *
	 * Validates:
	 * 1. The target canonical name must exist
	 * 2. The alias cannot shadow an existing canonical name
	 * 3. The alias cannot already exist pointing to a different target
	 *
	 * @param alias - The short alias (e.g., "py3d")
	 * @param canonicalName - The target canonical name (e.g., "python-tools:3d-visualizer")
	 * @returns Result indicating success or failure with reason
	 */
	registerAlias(alias: string, canonicalName: string): AliasRegistrationResult {
		// Check that target canonical name exists
		if (!this.components.has(canonicalName)) {
			return {
				success: false,
				reason: 'canonical-not-found',
				message: `Cannot create alias "${alias}": target canonical name "${canonicalName}" does not exist`,
			};
		}

		// Check that alias doesn't shadow an existing canonical name
		if (this.components.has(alias)) {
			return {
				success: false,
				reason: 'shadows-canonical',
				message: `Cannot create alias "${alias}": it shadows an existing canonical name`,
			};
		}

		// Check for duplicate alias pointing to different target
		const existingTarget = this.aliasMap.get(alias);
		if (existingTarget !== undefined && existingTarget !== canonicalName) {
			return {
				success: false,
				reason: 'duplicate-alias',
				message: `Cannot create alias "${alias}": already exists pointing to "${existingTarget}"`,
			};
		}

		// Register the alias (idempotent if same target)
		this.aliasMap.set(alias, canonicalName);

		return { success: true };
	}

	/**
	 * Remove an alias.
	 *
	 * @param alias - The alias to remove
	 * @returns true if the alias existed and was removed, false otherwise
	 */
	removeAlias(alias: string): boolean {
		return this.aliasMap.delete(alias);
	}

	/**
	 * Resolve an alias to its canonical name.
	 *
	 * @param alias - The alias to resolve
	 * @returns The canonical name if alias exists, undefined otherwise
	 */
	resolveAlias(alias: string): string | undefined {
		return this.aliasMap.get(alias);
	}

	/**
	 * Get all registered aliases.
	 *
	 * @returns A copy of the alias map (alias -> canonicalName)
	 */
	getAliases(): Map<string, string> {
		return new Map(this.aliasMap);
	}

	/**
	 * Check if an alias exists.
	 *
	 * @param alias - The alias to check
	 * @returns true if the alias exists, false otherwise
	 */
	hasAlias(alias: string): boolean {
		return this.aliasMap.has(alias);
	}
}

// ============================================================================
// Discovery Bridge Helper
// ============================================================================

/**
 * Convert a discovered plugin's inventory into registerable component entries.
 *
 * This helper bridges S01's discovery output (DiscoveredPlugin) with the
 * namespaced registry. It maps skill and agent directory names to component
 * entries with the plugin's namespace.
 *
 * @param plugin - A discovered plugin from S01's discovery process
 * @returns Array of registerable component entries (without canonicalName)
 */
export function componentsFromDiscovery(
	plugin: DiscoveredPlugin
): Omit<NamespacedComponent, 'canonicalName'>[] {
	const components: Omit<NamespacedComponent, 'canonicalName'>[] = [];

	// Use the plugin's canonical name as the namespace
	const namespace = plugin.canonicalName;

	// Extract common metadata from the plugin
	const commonMetadata: NamespacedComponent['metadata'] = {
		pluginVersion: plugin.version,
		pluginAuthor: plugin.author?.name,
		pluginHomepage: plugin.homepage,
		pluginCategory: plugin.category,
	};

	// Process skills
	for (const skillName of plugin.inventory.skills) {
		// Resolve the skill file path
		// Skills are in <plugin>/skills/<name>/SKILL.md or <plugin>/skills/<name>.md
		let filePath: string;
		if (plugin.resolvedPath) {
			const skillDirPath = `${plugin.resolvedPath}/skills/${skillName}`;
			// Prefer direct markdown file entries, otherwise directory with SKILL.md
			filePath = skillName.endsWith('.md')
				? `${plugin.resolvedPath}/skills/${skillName}`
				: `${skillDirPath}/SKILL.md`;
		} else {
			// External plugin - use placeholder path
			filePath = `<external>/${namespace}/skills/${skillName}/SKILL.md`;
		}

		components.push({
			name: skillName.replace(/\.md$/, ''), // Strip .md if present
			namespace,
			type: 'skill',
			filePath,
			source: `plugin:${namespace}`,
			description: undefined, // Would require reading the file
			metadata: {
				...commonMetadata,
				componentDir: skillName,
			},
		});
	}

	// Process agents
	for (const agentName of plugin.inventory.agents) {
		// Resolve the agent file path
		let filePath: string;
		if (plugin.resolvedPath) {
			const agentDirPath = `${plugin.resolvedPath}/agents/${agentName}`;
			filePath = agentName.endsWith('.md')
				? `${plugin.resolvedPath}/agents/${agentName}`
				: `${agentDirPath}/AGENT.md`;
		} else {
			filePath = `<external>/${namespace}/agents/${agentName}/AGENT.md`;
		}

		components.push({
			name: agentName.replace(/\.md$/, ''), // Strip .md if present
			namespace,
			type: 'agent',
			filePath,
			source: `plugin:${namespace}`,
			description: undefined, // Would require reading the file
			metadata: {
				...commonMetadata,
				componentDir: agentName,
			},
		});
	}

	return components;
}

// ============================================================================
// ComponentRegistry Bridge
// ============================================================================

/**
 * Sync all components in this NamespacedRegistry into the unified ComponentRegistry.
 * Call after populating the NamespacedRegistry with plugin discovery results.
 *
 * This ensures plugin-discovered components are visible to both the legacy
 * namespaced resolution system and the new unified ComponentRegistry.
 */
export function syncToComponentRegistry(registry: NamespacedRegistry): void {
	try {
		const { getComponentRegistry } = require('./component-registry.js');
		const { computeComponentId } = require('./component-types.js');

		const componentRegistry = getComponentRegistry();

		for (const comp of registry.getAll()) {
			const id = computeComponentId(comp.name, comp.namespace);

			// Skip if already registered (avoid duplicates)
			if (componentRegistry.has(id)) continue;

			componentRegistry.register({
				id,
				kind: comp.type === 'agent' ? 'agent' : 'skill',
				metadata: {
					name: comp.name,
					description: comp.description ?? '',
					namespace: comp.namespace,
					version: comp.metadata.pluginVersion,
					author: comp.metadata.pluginAuthor ? { name: comp.metadata.pluginAuthor } : undefined,
					tags: comp.metadata.pluginCategory ? [comp.metadata.pluginCategory] : undefined,
				},
				spec: comp.type === 'agent'
					? { systemPrompt: 'AGENT.md' }
					: { prompt: 'SKILL.md' },
				dirPath: comp.filePath.replace(/\/[^/]+$/, ''),
				filePath: comp.filePath,
				source: 'plugin',
				format: comp.type === 'agent' ? 'agent-md' : 'skill-md',
				enabled: true,
			});
		}
	} catch {
		// ComponentRegistry not available — no-op
	}
}

/**
 * Import components from the unified ComponentRegistry into this NamespacedRegistry.
 * Useful for populating the namespaced view from the registry's loaded state.
 */
export function syncFromComponentRegistry(registry: NamespacedRegistry): void {
	try {
		const { getComponentRegistry } = require('./component-registry.js');
		const componentRegistry = getComponentRegistry();

		for (const comp of componentRegistry.list({ enabledOnly: true })) {
			if (!comp.metadata.namespace) continue; // Only sync namespaced components

			const canonicalName = `${comp.metadata.namespace}:${comp.metadata.name}`;
			if (registry.has(canonicalName)) continue;

			registry.register({
				name: comp.metadata.name,
				namespace: comp.metadata.namespace,
				type: comp.kind === 'agent' ? 'agent' : 'skill',
				filePath: comp.filePath,
				source: `plugin:${comp.metadata.namespace}`,
				description: comp.metadata.description,
				metadata: {
					pluginVersion: comp.metadata.version,
					pluginAuthor: comp.metadata.author?.name,
				},
			});
		}
	} catch {
		// ComponentRegistry not available — no-op
	}
}

// ============================================================================
// Exports
// ============================================================================

export default NamespacedRegistry;
