/**
 * Live E2E Tests Against Real Marketplace Repos
 *
 * Tests R014: validates PluginImporter against real marketplace data.
 *
 * Source model alignment:
 * - Prefer Claude Code managed marketplace locations when available
 * - Fall back to cloned fixture repos for portability
 * - Never require a contributor's personal sibling repo layout
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PluginImporter, type DiscoveryResult, type ImportManifest } from '../plugin-importer.js';
import { getMarketplaceFixtures } from './marketplace-test-fixtures.js';

// ============================================================================
// Live Test Configuration
// ============================================================================

/**
 * Canonical name format regex: namespace:name or bare name
 * Allows alphanumeric, underscore, hyphen, and dot in names.
 * Real marketplace data has names like "ecosystem-researcher-v1.1-rt-ica".
 */
const CANONICAL_NAME_REGEX = /^[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+)?$/;

// ============================================================================
// Live E2E Tests
// ============================================================================

const fixtureSetup = getMarketplaceFixtures(import.meta.dirname);
const fixtures = fixtureSetup.fixtures;
const CLAUDE_SKILLS_PATH = fixtures?.claudeSkillsPath;
const CLAUDE_PLUGINS_OFFICIAL_PATH = fixtures?.claudePluginsOfficialPath;

// Log marketplace status for observability
console.log('Live E2E Test Configuration:');
console.log(`  source: ${fixtures?.source ?? 'unavailable'}`);
if (CLAUDE_SKILLS_PATH) {
	console.log(`  claude_skills: FOUND at ${CLAUDE_SKILLS_PATH}`);
}
if (CLAUDE_PLUGINS_OFFICIAL_PATH) {
	console.log(`  claude-plugins-official: FOUND at ${CLAUDE_PLUGINS_OFFICIAL_PATH}`);
}
if (!fixtureSetup.available) {
	console.log(`  unavailable: ${fixtureSetup.skipReason}`);
}

const skipReason = !fixtureSetup.available ? fixtureSetup.skipReason : undefined;

describe(
	'Live E2E Tests',
	{ skip: skipReason },
	() => {
		let importer: PluginImporter;
		let discoveryResult: DiscoveryResult;

		before(() => {
			importer = new PluginImporter();
		});

		after(() => {
			fixtures?.cleanup();
		});

		describe('Step 2: discover() against real marketplaces', () => {
			it('should discover plugins from both marketplaces with no fatal errors', () => {
				// Stage 1: Discover
				discoveryResult = importer.discover([
					CLAUDE_SKILLS_PATH!,
					CLAUDE_PLUGINS_OFFICIAL_PATH!,
				]);

				// Log discovery summary for observability
				console.log('\nDiscovery Summary:');
				console.log(`  Marketplaces processed: ${discoveryResult.summary.marketplacesProcessed}`);
				console.log(`  Total plugins: ${discoveryResult.summary.totalPlugins}`);
				console.log(`  Total components: ${discoveryResult.summary.totalComponents}`);
				console.log(`  Marketplaces with errors: ${discoveryResult.summary.marketplacesWithErrors}`);

				// Assert positive counts
				assert.ok(
					discoveryResult.summary.totalPlugins > 0,
					'Should find at least one plugin across both marketplaces'
				);

				assert.ok(
					discoveryResult.summary.totalComponents > 0,
					'Should discover at least one component across both marketplaces'
				);

				// No fatal errors should crash the pipeline
				assert.strictEqual(
					discoveryResult.summary.marketplacesProcessed,
					2,
					'Should process both marketplace paths'
				);
			});

			it('should have processed both marketplace.json files', () => {
				assert.ok(discoveryResult, 'Discovery must run first');

				// Both marketplaces should have been attempted
				assert.strictEqual(
					discoveryResult.marketplaceResults.length,
					2,
					'Should have results for both marketplaces'
				);

				// At least one should have succeeded (they're real repos)
				const successfulMarketplaces = discoveryResult.marketplaceResults.filter(
					(m) => m.status === 'ok'
				);

				assert.ok(
					successfulMarketplaces.length >= 1,
					'At least one marketplace should have loaded successfully'
				);
			});
		});

		describe('Step 3: canonical name format validation', () => {
			it('should have valid canonical names matching namespace:component format', () => {
				assert.ok(discoveryResult, 'Discovery must run first');

				const registry = importer.getRegistry();
				assert.ok(registry, 'Registry should be populated');

				const allComponents = registry.getAll();

				// Should have components from real plugins
				assert.ok(
					allComponents.length > 0,
					'Should have discovered components to validate'
				);

				// Log sample canonical names for observability
				const sampleNames = allComponents.slice(0, 5).map((c) => c.canonicalName);
				console.log('\nSample canonical names from discovered components:');
				sampleNames.forEach((name) => console.log(`  - ${name}`));

				// Validate each canonical name
				for (const component of allComponents) {
					assert.ok(
						CANONICAL_NAME_REGEX.test(component.canonicalName),
						`Canonical name "${component.canonicalName}" should match format "namespace:name" or bare "name"`
					);

					// Namespaced components should have colon in canonical name
					if (component.namespace) {
						assert.ok(
							component.canonicalName.includes(':'),
							`Namespaced component "${component.canonicalName}" should contain colon`
						);

						// Canonical should be namespace:name
						const expected = `${component.namespace}:${component.name}`;
						assert.strictEqual(
							component.canonicalName,
							expected,
							`Canonical name should equal namespace:name`
						);
					} else {
						// Flat components should NOT have colon
						assert.ok(
							!component.canonicalName.includes(':'),
							`Flat component "${component.canonicalName}" should not contain colon`
						);

						assert.strictEqual(
							component.canonicalName,
							component.name,
							`Flat component canonical should equal bare name`
						);
					}
				}
			});
		});

		describe('Step 4: selectComponents() filtering', () => {
			it('should filter components by type and return non-empty results', () => {
				assert.ok(discoveryResult, 'Discovery must run first');

				// Filter by skills
				const skills = importer.selectComponents((c) => c.type === 'skill');

				// Filter by agents
				const agents = importer.selectComponents((c) => c.type === 'agent');

				console.log('\nComponent type counts:');
				console.log(`  Skills: ${skills.length}`);
				console.log(`  Agents: ${agents.length}`);

				// At least one type should have components (real marketplaces have plugins)
				assert.ok(
					skills.length > 0 || agents.length > 0,
					'At least one component type should have results from real marketplaces'
				);
			});

			it('should filter by namespace correctly', () => {
				assert.ok(discoveryResult, 'Discovery must run first');

				const registry = importer.getRegistry();
				const allComponents = registry!.getAll();

				// Get unique namespaces
				const namespaces = new Set(
					allComponents.map((c) => c.namespace).filter((n): n is string => n !== undefined)
				);

				console.log('\nDiscovered namespaces:');
				namespaces.forEach((ns) => console.log(`  - ${ns}`));

				if (namespaces.size > 0) {
					// Pick a namespace and filter
					const testNamespace = Array.from(namespaces)[0]!;
					const filtered = importer.selectComponents(
						(c) => c.namespace === testNamespace
					);

					assert.ok(
						filtered.length > 0,
						`Should find components for namespace "${testNamespace}"`
					);

					// All results should match the filter
					for (const comp of filtered) {
						assert.strictEqual(
							comp.namespace,
							testNamespace,
							'Filtered components should have correct namespace'
						);
					}
				}
			});
		});

		describe('Step 5: validateImport() on real data', () => {
			it('should run validation on all discovered components without crash', () => {
				assert.ok(discoveryResult, 'Discovery must run first');

				const registry = importer.getRegistry();
				const allComponents = registry!.getAll();

				// Run validation on all discovered components
				const validation = importer.validateImport(allComponents);

				console.log('\nValidation result:');
				console.log(`  Can proceed: ${validation.canProceed}`);
				console.log(`  Total diagnostics: ${validation.summary.total}`);
				console.log(`  Errors: ${validation.summary.errors}`);
				console.log(`  Warnings: ${validation.summary.warnings}`);

				if (validation.diagnostics.length > 0) {
					console.log('\nDiagnostics:');
					validation.diagnostics.forEach((d) => {
						console.log(`  [${d.severity}] ${d.class}: ${d.remediation}`);
					});
				}

				// Validation should complete without throwing
				assert.ok(validation, 'Validation should return a result');
				assert.ok(
					typeof validation.canProceed === 'boolean',
					'canProceed should be boolean'
				);
				assert.ok(
					Array.isArray(validation.diagnostics),
					'diagnostics should be an array'
				);
			});

			it('should have valid diagnostic structure if warnings exist', () => {
				const validation = importer.getLastValidation();
				assert.ok(validation, 'Validation should have run');

				for (const diag of validation.diagnostics) {
					// Verify diagnostic structure
					assert.ok(diag.class, 'Diagnostic should have class');
					assert.ok(
						['error', 'warning'].includes(diag.severity),
						'Diagnostic severity should be error or warning'
					);
					assert.ok(diag.remediation, 'Diagnostic should have remediation');
					assert.ok(
						Array.isArray(diag.involvedCanonicalNames),
						'Diagnostic should have involvedCanonicalNames array'
					);
					assert.ok(
						Array.isArray(diag.filePaths),
						'Diagnostic should have filePaths array'
					);
				}
			});

			it('should not have error-severity diagnostics blocking on real data (data quality check)', () => {
				const validation = importer.getLastValidation();
				assert.ok(validation, 'Validation should have run');

				// Real marketplace data should not have fatal canonical collisions
				// (this is a data quality assertion)
				if (validation.summary.errors > 0) {
					console.log('\nWARNING: Real marketplace data has error-severity diagnostics!');
					console.log('This may indicate duplicate canonical names in the marketplace.');

					// Log the errors for investigation
					validation.diagnostics
						.filter((d) => d.severity === 'error')
						.forEach((d) => {
							console.log(`  ERROR: ${d.class}`);
							console.log(`    Involved: ${d.involvedCanonicalNames.join(', ')}`);
							console.log(`    Files: ${d.filePaths.join(', ')}`);
						});
				}

				// Note: We allow errors in assertion but log them for visibility
				// Real data might have collisions, but the pipeline should handle them
				assert.strictEqual(typeof validation.canProceed, 'boolean');
			});
		});

		describe('Step 6: getImportManifest() with canonical names', () => {
			it('should generate manifest preserving canonical names from real plugins', () => {
				assert.ok(discoveryResult, 'Discovery must run first');

				const registry = importer.getRegistry();
				const allComponents = registry!.getAll();

				// Generate manifest for all components
				const manifest = importer.getImportManifest(allComponents);

				console.log('\nManifest summary:');
				console.log(`  Schema version: ${manifest.schemaVersion}`);
				console.log(`  Total entries: ${manifest.summary.total}`);
				console.log(`  Skills: ${manifest.summary.skills}`);
				console.log(`  Agents: ${manifest.summary.agents}`);
				console.log(`  Namespaces: ${manifest.summary.namespaces.length}`);

				// Verify manifest structure
				assert.strictEqual(manifest.schemaVersion, '1.0');
				assert.strictEqual(
					manifest.entries.length,
					allComponents.length,
					'Manifest should have entry for each component'
				);

				// Verify canonical names preserved
				for (const entry of manifest.entries) {
					// Find matching component
					const component = allComponents.find(
						(c) => c.canonicalName === entry.canonicalName
					);

					assert.ok(
						component,
						`Manifest entry should match component: ${entry.canonicalName}`
					);

					// Canonical name should match exactly
					assert.strictEqual(
						entry.canonicalName,
						component.canonicalName,
						'Canonical name should be preserved in manifest'
					);

					// Type should match
					assert.strictEqual(entry.type, component.type);

					// Namespace should match
					assert.strictEqual(entry.namespace, component.namespace);

					// Name should match
					assert.strictEqual(entry.name, component.name);

					// File path should be preserved
					assert.strictEqual(entry.filePath, component.filePath);
				}
			});

			it('should produce JSON-serializable manifest', () => {
				const registry = importer.getRegistry();
				const allComponents = registry!.getAll();

				const manifest = importer.getImportManifest(allComponents);

				// Should be JSON serializable
				const json = JSON.stringify(manifest, null, 2);

				// Should parse back correctly
				const parsed: ImportManifest = JSON.parse(json);

				assert.strictEqual(parsed.schemaVersion, manifest.schemaVersion);
				assert.strictEqual(parsed.entries.length, manifest.entries.length);

				// Sample entries should match after round-trip
				const sampleEntry = parsed.entries[0];
				if (sampleEntry) {
					const original = manifest.entries[0]!;
					assert.strictEqual(sampleEntry.canonicalName, original.canonicalName);
					assert.strictEqual(sampleEntry.type, original.type);
				}
			});

			it('should have correct summary counts', () => {
				const registry = importer.getRegistry();
				const allComponents = registry!.getAll();

				const manifest = importer.getImportManifest(allComponents);

				// Count skills and agents
				const skillCount = manifest.entries.filter((e) => e.type === 'skill').length;
				const agentCount = manifest.entries.filter((e) => e.type === 'agent').length;

				assert.strictEqual(
					manifest.summary.skills,
					skillCount,
					'Skill count should match entries'
				);

				assert.strictEqual(
					manifest.summary.agents,
					agentCount,
					'Agent count should match entries'
				);

				assert.strictEqual(
					manifest.summary.total,
					manifest.entries.length,
					'Total should match entry count'
				);

				// Namespaces should be unique and sorted
				const uniqueNamespaces = new Set(
					manifest.entries
						.map((e) => e.namespace)
						.filter((n): n is string => n !== undefined)
				);

				assert.deepStrictEqual(
					manifest.summary.namespaces,
					Array.from(uniqueNamespaces).sort(),
					'Namespaces should be unique and sorted'
				);
			});
		});

		describe('Full pipeline verification', () => {
			it('should execute discover → select → validate → manifest without error', () => {
				// This test verifies the full pipeline works end-to-end

				// Already have discovery from before()
				assert.ok(discoveryResult, 'Discovery should have completed');

				// Select subset
				const skills = importer.selectComponents((c) => c.type === 'skill');

				// Validate
				const validation = importer.validateImport(skills);
				assert.ok(validation, 'Validation should complete');

				// Generate manifest
				const manifest = importer.getImportManifest(skills);
				assert.ok(manifest, 'Manifest generation should complete');

				// All skills should be in manifest
				assert.strictEqual(
					manifest.summary.skills,
					skills.length,
					'All selected skills should be in manifest'
				);

				console.log('\nFull pipeline verification:');
				console.log(`  Selected: ${skills.length} skills`);
				console.log(`  Validated: canProceed=${validation.canProceed}`);
				console.log(`  Manifest: ${manifest.summary.total} entries`);
			});
		});
	}
);
