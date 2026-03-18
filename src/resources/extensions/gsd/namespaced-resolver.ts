/**
 * Namespaced Resolver Module
 *
 * Implements context-aware resolution with three-tier lookup precedence:
 * 1. Canonical (fully-qualified names with `:`)
 * 2. Local-first (caller namespace + bare name)
 * 3. Shorthand (bare name matched across all namespaces)
 *
 * This is the core logic for D003 (same-plugin local-first) and R007/R008 (safe shorthand).
 */

import type { NamespacedRegistry, NamespacedComponent, ComponentType } from './namespaced-registry.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Resolution context provided by the caller.
 * Used to enable local-first resolution within a namespace.
 */
export interface ResolutionContext {
	/** The namespace of the calling component (e.g., "farm" from "farm:caller") */
	callerNamespace?: string;
}

/**
 * Base structure for all resolution results.
 */
interface ResolutionResultBase {
	/** The original name passed to resolve() */
	requestedName: string;

	/** How the resolution was performed */
	resolution: 'canonical' | 'alias' | 'local-first' | 'shorthand' | 'ambiguous' | 'not-found';
}

/**
 * Result when a canonical (fully-qualified) name matches exactly.
 * Example: "farm:call-horse" resolves directly to the component with that canonical name.
 */
export interface CanonicalResolution extends ResolutionResultBase {
	resolution: 'canonical';
	/** The matched component */
	component: NamespacedComponent;
}

/**
 * Result when an alias resolves to a canonical name.
 * Example: "py3d" resolves via alias to "python-tools:3d-visualizer".
 */
export interface AliasResolution extends ResolutionResultBase {
	resolution: 'alias';
	/** The matched component */
	component: NamespacedComponent;
	/** The alias that was resolved */
	alias: string;
	/** The canonical name the alias points to */
	canonicalName: string;
}

/**
 * Result when a bare name resolves via local-first lookup.
 * Example: A caller in namespace "farm" resolving bare "call-horse" matches "farm:call-horse".
 */
export interface LocalFirstResolution extends ResolutionResultBase {
	resolution: 'local-first';
	/** The matched component */
	component: NamespacedComponent;
	/** The namespace used for local-first resolution */
	matchedNamespace: string;
}

/**
 * Result when a bare name matches exactly one component across all namespaces.
 * Example: "feed-chickens" resolves if only "farm:feed-chickens" exists.
 */
export interface ShorthandResolution extends ResolutionResultBase {
	resolution: 'shorthand';
	/** The matched component */
	component: NamespacedComponent;
}

/**
 * Result when a bare name matches multiple components across namespaces.
 * Returns all candidates for diagnostic consumption without throwing.
 * Example: "call-horse" matches both "farm:call-horse" and "zoo:call-horse".
 */
export interface AmbiguousResolution extends ResolutionResultBase {
	resolution: 'ambiguous';
	/** All components matching the bare name */
	candidates: NamespacedComponent[];
}

/**
 * Result when no component matches the requested name.
 */
export interface NotFoundResolution extends ResolutionResultBase {
	resolution: 'not-found';
}

/**
 * Discriminated union of all resolution results.
 * The `resolution` field indicates which variant applies.
 */
export type ResolutionResult =
	| CanonicalResolution
	| AliasResolution
	| LocalFirstResolution
	| ShorthandResolution
	| AmbiguousResolution
	| NotFoundResolution;

// ============================================================================
// NamespacedResolver Class
// ============================================================================

/**
 * Resolver for namespaced components with context-aware lookup.
 *
 * Implements four-tier resolution precedence:
 * 1. **Canonical**: If name contains `:`, try exact match → return canonical result
 * 2. **Alias**: If name is a registered alias → return alias result
 * 3. **Local-first**: If `context.callerNamespace` exists, try `${callerNamespace}:${name}` → return local-first result
 * 4. **Shorthand**: Scan all components for bare name match → single match returns shorthand, multiple returns ambiguous
 *
 * Usage:
 * ```typescript
 * const registry = new NamespacedRegistry();
 * // ... populate registry ...
 * // ... register aliases ...
 *
 * const resolver = new NamespacedResolver(registry);
 *
 * // Canonical lookup
 * const canon = resolver.resolve('farm:call-horse');
 * // canon.resolution === 'canonical'
 *
 * // Alias resolution
 * const alias = resolver.resolve('py3d');
 * // alias.resolution === 'alias', alias.canonicalName === 'python-tools:3d-visualizer'
 *
 * // Local-first resolution from caller context
 * const local = resolver.resolve('call-horse', { callerNamespace: 'farm' });
 * // local.resolution === 'local-first'
 *
 * // Unambiguous shorthand
 * const short = resolver.resolve('unique-skill');
 * // short.resolution === 'shorthand'
 *
 * // Ambiguous shorthand
 * const amb = resolver.resolve('common-skill');
 * // amb.resolution === 'ambiguous', amb.candidates has all matches
 * ```
 */
export class NamespacedResolver {
	/** The registry to resolve against */
	private registry: NamespacedRegistry;

	/**
	 * Create a new resolver for the given registry.
	 *
	 * @param registry - The namespaced registry to resolve against
	 */
	constructor(registry: NamespacedRegistry) {
		this.registry = registry;
	}

	/**
	 * Resolve a component name with context-aware lookup.
	 *
	 * Implements four-tier resolution precedence:
	 * 1. **Canonical**: If name contains `:`, try exact match → return canonical result
	 * 2. **Alias**: If name is a registered alias → return alias result
	 * 3. **Local-first**: If `context.callerNamespace` exists, try `${callerNamespace}:${name}` → return local-first result
	 * 4. **Shorthand**: Scan all components for bare name match → single match returns shorthand, multiple returns ambiguous
	 *
	 * @param name - The name to resolve (canonical or bare)
	 * @param context - Optional resolution context with caller namespace
	 * @param type - Optional type filter (skill or agent)
	 * @returns Resolution result indicating how the match was found
	 */
	resolve(
		name: string,
		context?: ResolutionContext,
		type?: ComponentType
	): ResolutionResult {
		// Tier 1: Canonical lookup (name contains `:`)
		if (name.includes(':')) {
			const component = this.registry.getByCanonical(name);

			if (component && this.matchesType(component, type)) {
				return {
					requestedName: name,
					resolution: 'canonical',
					component,
				};
			}

			// Canonical name not found
			return {
				requestedName: name,
				resolution: 'not-found',
			};
		}

		// Tier 2: Alias lookup (before local-first and shorthand)
		const aliasTarget = this.registry.resolveAlias(name);
		if (aliasTarget) {
			const component = this.registry.getByCanonical(aliasTarget);
			if (component && this.matchesType(component, type)) {
				return {
					requestedName: name,
					resolution: 'alias',
					component,
					alias: name,
					canonicalName: aliasTarget,
				};
			}
		}

		// Tier 3: Local-first resolution (if caller namespace provided)
		if (context?.callerNamespace) {
			const localCanonical = `${context.callerNamespace}:${name}`;
			const component = this.registry.getByCanonical(localCanonical);

			if (component && this.matchesType(component, type)) {
				return {
					requestedName: name,
					resolution: 'local-first',
					component,
					matchedNamespace: context.callerNamespace,
				};
			}
		}

		// Tier 4: Shorthand resolution (scan all components)
		const candidates = this.findBareNameMatches(name, type);

		if (candidates.length === 0) {
			return {
				requestedName: name,
				resolution: 'not-found',
			};
		}

		if (candidates.length === 1) {
			return {
				requestedName: name,
				resolution: 'shorthand',
				component: candidates[0],
			};
		}

		// Multiple matches - ambiguous
		return {
			requestedName: name,
			resolution: 'ambiguous',
			candidates,
		};
	}

	/**
	 * Find all components whose local name (without namespace) matches the given bare name.
	 * Optionally filters by component type.
	 *
	 * @param bareName - The bare name to match
	 * @param type - Optional type filter
	 * @returns Array of matching components
	 */
	private findBareNameMatches(
		bareName: string,
		type?: ComponentType
	): NamespacedComponent[] {
		const all = this.registry.getAll();

		return all.filter((component) => {
			// Match by local name (component.name)
			if (component.name !== bareName) {
				return false;
			}

			// Apply type filter if provided
			return this.matchesType(component, type);
		});
	}

	/**
	 * Check if a component matches the optional type filter.
	 *
	 * @param component - The component to check
	 * @param type - Optional type filter
	 * @returns true if no filter or type matches
	 */
	private matchesType(
		component: NamespacedComponent,
		type?: ComponentType
	): boolean {
		return type === undefined || component.type === type;
	}
}

// ============================================================================
// ComponentRegistry Fallback Resolution
// ============================================================================

/**
 * Resolve a component name using the unified ComponentRegistry as a fallback
 * when the NamespacedRegistry doesn't have a match.
 *
 * This allows references to work across both old-style (NamespacedRegistry)
 * and new-style (ComponentRegistry) registrations.
 */
export function resolveViaComponentRegistry(
	name: string,
	type?: ComponentType,
): NamespacedComponent | undefined {
	try {
		const { getComponentRegistry } = require('./component-registry.js');
		const registry = getComponentRegistry();
		const comp = registry.resolve(name);
		if (!comp) return undefined;

		// Apply type filter
		const compType: ComponentType = comp.kind === 'agent' ? 'agent' : 'skill';
		if (type && compType !== type) return undefined;

		// Convert to NamespacedComponent format
		return {
			name: comp.metadata.name,
			namespace: comp.metadata.namespace,
			canonicalName: comp.id,
			type: compType,
			filePath: comp.filePath,
			source: comp.source,
			description: comp.metadata.description,
			metadata: {
				pluginVersion: comp.metadata.version,
				pluginAuthor: comp.metadata.author?.name,
			},
		};
	} catch {
		return undefined;
	}
}

// ============================================================================
// Exports
// ============================================================================

export default NamespacedResolver;
