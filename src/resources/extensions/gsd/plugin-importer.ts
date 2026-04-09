/**
 * PluginImporter Service
 *
 * Composes S01-S04 modules into a staged discover → select → validate → commit pipeline.
 * Each stage is independently testable. The service owns no UI — it produces data structures
 * that the command layer (T02) consumes.
 *
 * Pipeline stages:
 * 1. discover(marketplacePaths) - Read marketplace manifests, populate registry
 * 2. selectComponents(filter) - Filter to user-chosen components
 * 3. validateImport(selected) - Check for collisions, return diagnostics
 * 4. getImportManifest(selected) - Produce serializable config structure
 *
 * This service implements R012 (discover/select/import flow) and R013 (canonical name preservation).
 */

import {
	discoverMarketplace,
	type MarketplaceDiscoveryResult,
	type DiscoveredPlugin,
} from './marketplace-discovery.js';
import { GSDError, GSD_STALE_STATE } from './errors.js';
import {
	NamespacedRegistry,
	componentsFromDiscovery,
	type NamespacedComponent,
} from './namespaced-registry.js';
import { NamespacedResolver } from './namespaced-resolver.js';
import {
	analyzeCollisions,
	type ClassifiedDiagnostic,
} from './collision-diagnostics.js';
import { nowIso } from './time-utils.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Result of the discovery stage.
 * Contains all discovered plugins and the populated registry.
 */
export interface DiscoveryResult {
	/** All discovery results from each marketplace path */
	marketplaceResults: MarketplaceDiscoveryResult[];

	/** All discovered plugins aggregated */
	plugins: DiscoveredPlugin[];

	/** The populated registry with all components */
	registry: NamespacedRegistry;

	/** Summary counts */
	summary: {
		marketplacesProcessed: number;
		marketplacesWithErrors: number;
		totalPlugins: number;
		pluginsWithErrors: number;
		totalComponents: number;
	};
}

/**
 * Result of the validation stage.
 * Contains diagnostics and a proceed flag.
 */
export interface ValidationResult {
	/** All classified diagnostics (errors and warnings) */
	diagnostics: ClassifiedDiagnostic[];

	/** True if import can proceed (no error-severity diagnostics) */
	canProceed: boolean;

	/** Summary counts */
	summary: {
		total: number;
		errors: number;
		warnings: number;
	};
}

/**
 * A single entry in the import manifest config.
 * Represents one component to be imported.
 */
export interface ImportManifestEntry {
	/** Canonical name: `namespace:name` or bare `name` */
	canonicalName: string;

	/** Component type: 'skill' or 'agent' */
	type: 'skill' | 'agent';

	/** Local component name (without namespace) */
	name: string;

	/** Plugin namespace (undefined for flat components) */
	namespace: string | undefined;

	/** Absolute path to the component's definition file */
	filePath: string;

	/** Source identifier (e.g., "plugin:my-plugin") */
	source: string;

	/** Optional description */
	description?: string;

	/** Plugin metadata for provenance */
	metadata: {
		pluginVersion?: string;
		pluginAuthor?: string;
		pluginHomepage?: string;
		pluginCategory?: string;
	};
}

/**
 * The complete import manifest structure.
 * Serializable to JSON for persistence.
 */
export interface ImportManifest {
	/** Schema version for future compatibility */
	schemaVersion: '1.0';

	/** Timestamp when manifest was generated */
	generatedAt: string;

	/** All entries to be imported */
	entries: ImportManifestEntry[];

	/** Summary counts */
	summary: {
		total: number;
		skills: number;
		agents: number;
		namespaces: string[];
	};
}

// ============================================================================
// PluginImporter Class
// ============================================================================

/**
 * Service for discovering, selecting, validating, and importing plugin components.
 *
 * Usage:
 * ```typescript
 * const importer = new PluginImporter();
 *
 * // Stage 1: Discover
 * const discovery = importer.discover(['../claude-plugins']);
 *
 * // Stage 2: Select
 * const selected = importer.selectComponents(c => c.namespace === 'my-plugin');
 *
 * // Stage 3: Validate
 * const validation = importer.validateImport(selected);
 * if (!validation.canProceed) {
 *   console.error('Cannot import:', validation.diagnostics);
 *   return;
 * }
 *
 * // Stage 4: Get manifest for persistence
 * const manifest = importer.getImportManifest(selected);
 * ```
 */
export class PluginImporter {
	/** The internal registry populated during discovery */
	private registry: NamespacedRegistry | null = null;

	/** All discovered plugins from the last discovery run */
	private discoveredPlugins: DiscoveredPlugin[] = [];

	/** Last discovery result for inspection */
	private lastDiscoveryResult: DiscoveryResult | null = null;

	/** Last validation result for inspection */
	private lastValidationResult: ValidationResult | null = null;

	/**
	 * Stage 1: Discover plugins from marketplace paths.
	 *
	 * Calls `discoverMarketplace()` for each path and populates a `NamespacedRegistry`
	 * via `componentsFromDiscovery()`.
	 *
	 * @param marketplacePaths - Array of paths to marketplace directories
	 * @returns Discovery result with registry and summary
	 */
	discover(marketplacePaths: string[]): DiscoveryResult {
		// Reset state for fresh discovery
		this.registry = new NamespacedRegistry();
		this.discoveredPlugins = [];
		this.lastValidationResult = null;

		const marketplaceResults: MarketplaceDiscoveryResult[] = [];
		let marketplacesWithErrors = 0;
		let pluginsWithErrors = 0;

		// Process each marketplace path
		for (const marketplacePath of marketplacePaths) {
			const result = discoverMarketplace(marketplacePath);
			marketplaceResults.push(result);

			if (result.status === 'error') {
				marketplacesWithErrors++;
			}

			// Collect all plugins
			for (const plugin of result.plugins) {
				this.discoveredPlugins.push(plugin);

				if (plugin.status === 'error') {
					pluginsWithErrors++;
				}

				// Convert plugin inventory to components and register
				const components = componentsFromDiscovery(plugin);
				for (const component of components) {
					this.registry!.register(component);
				}
			}
		}

		// Build summary
		const summary = {
			marketplacesProcessed: marketplacePaths.length,
			marketplacesWithErrors,
			totalPlugins: this.discoveredPlugins.length,
			pluginsWithErrors,
			totalComponents: this.registry.size,
		};

		this.lastDiscoveryResult = {
			marketplaceResults,
			plugins: this.discoveredPlugins,
			registry: this.registry,
			summary,
		};

		return this.lastDiscoveryResult;
	}

	/**
	 * Stage 2: Select components by filter function.
	 *
	 * Returns a filtered subset of registered components.
	 * Must be called after discover().
	 *
	 * @param componentFilter - Filter function returning true for selected components
	 * @returns Array of selected components
	 */
	selectComponents(
		componentFilter: (component: NamespacedComponent) => boolean
	): NamespacedComponent[] {
		if (!this.registry) {
			throw new GSDError(GSD_STALE_STATE, 'Must call discover() before selectComponents()');
		}

		return this.registry.getAll().filter(componentFilter);
	}

	/**
	 * Stage 3: Validate selected components for import.
	 *
	 * Builds a `NamespacedResolver`, runs `analyzeCollisions()`, and returns
	 * `{ diagnostics, canProceed }` where `canProceed` is false if any
	 * error-severity diagnostics exist.
	 *
	 * @param selected - Array of components to validate
	 * @returns Validation result with diagnostics and proceed flag
	 */
	validateImport(selected: NamespacedComponent[]): ValidationResult {
		if (!this.registry) {
			throw new GSDError(GSD_STALE_STATE, 'Must call discover() before validateImport()');
		}

		// Create a temporary resolver for the selected components
		const tempRegistry = new NamespacedRegistry();

		// Register only selected components into temp registry
		for (const component of selected) {
			tempRegistry.register({
				name: component.name,
				namespace: component.namespace,
				type: component.type,
				filePath: component.filePath,
				source: component.source,
				description: component.description,
				metadata: component.metadata,
			});
		}

		// Create resolver and analyze collisions
		const resolver = new NamespacedResolver(tempRegistry);
		const diagnostics = analyzeCollisions(tempRegistry, resolver);

		// Count by severity
		const errors = diagnostics.filter((d) => d.severity === 'error').length;
		const warnings = diagnostics.filter((d) => d.severity === 'warning').length;

		const summary = {
			total: diagnostics.length,
			errors,
			warnings,
		};

		// canProceed is false if any error-severity diagnostics exist
		const canProceed = errors === 0;

		this.lastValidationResult = {
			diagnostics,
			canProceed,
			summary,
		};

		return this.lastValidationResult;
	}

	/**
	 * Stage 4: Generate import manifest for selected components.
	 *
	 * Produces a serializable config structure with canonical names preserved.
	 * The manifest can be persisted to config files.
	 *
	 * @param selected - Array of components to include in manifest
	 * @returns Import manifest with all entries and metadata
	 */
	getImportManifest(selected: NamespacedComponent[]): ImportManifest {
		const entries: ImportManifestEntry[] = selected.map((component) => ({
			canonicalName: component.canonicalName,
			type: component.type,
			name: component.name,
			namespace: component.namespace,
			filePath: component.filePath,
			source: component.source,
			description: component.description,
			metadata: {
				pluginVersion: component.metadata.pluginVersion,
				pluginAuthor: component.metadata.pluginAuthor,
				pluginHomepage: component.metadata.pluginHomepage,
				pluginCategory: component.metadata.pluginCategory,
			},
		}));

		// Count by type
		const skills = entries.filter((e) => e.type === 'skill').length;
		const agents = entries.filter((e) => e.type === 'agent').length;

		// Collect unique namespaces
		const namespaces = Array.from(
			new Set(entries.map((e) => e.namespace).filter((n): n is string => n !== undefined))
		).sort();

		return {
			schemaVersion: '1.0',
			generatedAt: nowIso(),
			entries,
			summary: {
				total: entries.length,
				skills,
				agents,
				namespaces,
			},
		};
	}

	/**
	 * Get the internal registry for inspection.
	 * Useful for debugging or advanced filtering.
	 *
	 * @returns The registry or null if discover() hasn't been called
	 */
	getRegistry(): NamespacedRegistry | null {
		return this.registry;
	}

	/**
	 * Get all discovered plugins.
	 *
	 * @returns Array of discovered plugins
	 */
	getDiscoveredPlugins(): DiscoveredPlugin[] {
		return this.discoveredPlugins;
	}

	/**
	 * Get the last validation result.
	 * Useful for re-inspecting validation without re-running.
	 *
	 * @returns Last validation result or null
	 */
	getLastValidation(): ValidationResult | null {
		return this.lastValidationResult;
	}

	/**
	 * Get the last discovery result.
	 * Useful for re-inspecting discovery without re-running.
	 *
	 * @returns Last discovery result or null
	 */
	getLastDiscovery(): DiscoveryResult | null {
		return this.lastDiscoveryResult;
	}
}

// ============================================================================
// Exports
// ============================================================================

export default PluginImporter;
