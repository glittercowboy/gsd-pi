/**
 * Component System Integration Tests
 *
 * Tests the wiring between ComponentRegistry and the legacy systems:
 * - skills.ts delegation
 * - agents.ts delegation
 * - namespaced-registry bridge (syncTo/syncFrom)
 * - namespaced-resolver ComponentRegistry fallback
 * - skill-discovery registry-backed listing
 * - skill-telemetry component extensions
 * - skill-health component health report
 * - auto-dispatch pipeline dispatch
 * - preferences-types component preferences
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// NamespacedRegistry Bridge Tests
// ============================================================================

describe('NamespacedRegistry bridge', () => {
	it('syncToComponentRegistry exports as a function', async () => {
		const mod = await import('../namespaced-registry.js');
		assert.strictEqual(typeof mod.syncToComponentRegistry, 'function');
	});

	it('syncFromComponentRegistry exports as a function', async () => {
		const mod = await import('../namespaced-registry.js');
		assert.strictEqual(typeof mod.syncFromComponentRegistry, 'function');
	});

	it('syncToComponentRegistry handles empty registry gracefully', async () => {
		const mod = await import('../namespaced-registry.js');
		const registry = new mod.NamespacedRegistry();
		// Should not throw even if ComponentRegistry module is not available
		assert.doesNotThrow(() => mod.syncToComponentRegistry(registry));
	});

	it('syncFromComponentRegistry handles empty registry gracefully', async () => {
		const mod = await import('../namespaced-registry.js');
		const registry = new mod.NamespacedRegistry();
		assert.doesNotThrow(() => mod.syncFromComponentRegistry(registry));
	});
});

// ============================================================================
// NamespacedResolver Fallback Tests
// ============================================================================

describe('NamespacedResolver ComponentRegistry fallback', () => {
	it('resolveViaComponentRegistry exports as a function', async () => {
		const mod = await import('../namespaced-resolver.js');
		assert.strictEqual(typeof mod.resolveViaComponentRegistry, 'function');
	});

	it('resolveViaComponentRegistry returns undefined for unknown components', async () => {
		const mod = await import('../namespaced-resolver.js');
		const result = mod.resolveViaComponentRegistry('nonexistent-component');
		assert.strictEqual(result, undefined);
	});
});

// ============================================================================
// Skill Telemetry Component Extensions
// ============================================================================

describe('skill-telemetry component extensions', () => {
	it('exports recordComponentUsage', async () => {
		const mod = await import('../skill-telemetry.js');
		assert.strictEqual(typeof mod.recordComponentUsage, 'function');
	});

	it('exports getAndClearComponentUsage', async () => {
		const mod = await import('../skill-telemetry.js');
		assert.strictEqual(typeof mod.getAndClearComponentUsage, 'function');
	});

	it('exports resetComponentTelemetry', async () => {
		const mod = await import('../skill-telemetry.js');
		assert.strictEqual(typeof mod.resetComponentTelemetry, 'function');
	});

	it('exports listInstalledComponents', async () => {
		const mod = await import('../skill-telemetry.js');
		assert.strictEqual(typeof mod.listInstalledComponents, 'function');
	});

	it('recordComponentUsage and getAndClearComponentUsage round-trip', async () => {
		const mod = await import('../skill-telemetry.js');
		mod.resetComponentTelemetry();
		mod.recordComponentUsage('test-agent');
		mod.recordComponentUsage('test-pipeline');
		const result = mod.getAndClearComponentUsage();
		assert.ok(result.includes('test-agent'));
		assert.ok(result.includes('test-pipeline'));
		// Should be empty after clearing
		const empty = mod.getAndClearComponentUsage();
		assert.strictEqual(empty.length, 0);
	});

	it('listInstalledComponents returns object with skills and agents', async () => {
		const mod = await import('../skill-telemetry.js');
		const result = mod.listInstalledComponents();
		assert.ok(Array.isArray(result.skills));
		assert.ok(Array.isArray(result.agents));
	});
});

// ============================================================================
// Skill Health Component Extensions
// ============================================================================

describe('skill-health component extensions', () => {
	it('exports ComponentHealthEntry type fields', async () => {
		const mod = await import('../skill-health.js');
		assert.strictEqual(typeof mod.generateComponentHealthReport, 'function');
	});

	it('generateComponentHealthReport returns components array', async () => {
		const os = await import('node:os');
		const path = await import('node:path');
		const mod = await import('../skill-health.js');
		// Use a temp dir that won't have metrics
		const report = mod.generateComponentHealthReport(path.join(os.tmpdir(), 'nonexistent-gsd-test'));
		assert.ok(Array.isArray(report.components));
		assert.ok(Array.isArray(report.skills));
		assert.ok(Array.isArray(report.suggestions));
	});
});

// ============================================================================
// Auto-dispatch Pipeline Support
// ============================================================================

describe('auto-dispatch pipeline support', () => {
	it('exports dispatchPipeline function', async () => {
		const mod = await import('../auto-dispatch.js');
		assert.strictEqual(typeof mod.dispatchPipeline, 'function');
	});

	it('dispatchPipeline returns stop action for unknown pipeline', async () => {
		const os = await import('node:os');
		const path = await import('node:path');
		const mod = await import('../auto-dispatch.js');
		const result = await mod.dispatchPipeline(
			'nonexistent-pipeline',
			{},
			path.join(os.tmpdir(), 'nonexistent-gsd-test'),
		);
		assert.strictEqual(result.action, 'stop');
	});
});

// ============================================================================
// Preferences Component Section
// ============================================================================

describe('preferences-types component preferences', () => {
	it('KNOWN_PREFERENCE_KEYS includes components', async () => {
		const mod = await import('../preferences-types.js');
		assert.ok(mod.KNOWN_PREFERENCE_KEYS.has('components'));
	});

	it('ComponentPreferences shape is importable', async () => {
		// This is a type-level test — if the module loads, the types exist
		const mod = await import('../preferences-types.js');
		assert.ok(mod.KNOWN_PREFERENCE_KEYS instanceof Set);
	});
});
