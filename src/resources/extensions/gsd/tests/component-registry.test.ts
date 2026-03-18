/**
 * Component Registry — Unit Tests
 *
 * Tests for the unified component registry including:
 * - Registration and collision detection
 * - Resolution (exact, namespace-qualified, shorthand)
 * - Filtering and querying
 * - Enable/disable lifecycle
 * - Bridge methods for backward compatibility
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ComponentRegistry, resetComponentRegistry } from '../component-registry.js';
import type { Component } from '../component-types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestComponent(overrides: Partial<Component> = {}): Component {
	return {
		id: overrides.id ?? 'test-skill',
		kind: overrides.kind ?? 'skill',
		metadata: overrides.metadata ?? {
			name: 'test-skill',
			description: 'A test skill',
		},
		spec: overrides.spec ?? { prompt: 'SKILL.md' },
		dirPath: overrides.dirPath ?? '/test/skills/test-skill',
		filePath: overrides.filePath ?? '/test/skills/test-skill/SKILL.md',
		source: overrides.source ?? 'user',
		format: overrides.format ?? 'skill-md',
		enabled: overrides.enabled ?? true,
	};
}

// ============================================================================
// Registration
// ============================================================================

describe('ComponentRegistry — Registration', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		// Don't call load() — we'll register manually
		(registry as any).loaded = true;
	});

	it('registers a component successfully', () => {
		const component = createTestComponent();
		const diagnostic = registry.register(component);
		assert.strictEqual(diagnostic, undefined);
		assert.strictEqual(registry.size, 1);
	});

	it('detects collision on duplicate ID', () => {
		const comp1 = createTestComponent({ filePath: '/path/a/SKILL.md' });
		const comp2 = createTestComponent({ filePath: '/path/b/SKILL.md' });

		registry.register(comp1);
		const diagnostic = registry.register(comp2);

		assert.ok(diagnostic);
		assert.strictEqual(diagnostic.type, 'collision');
		assert.ok(diagnostic.collision);
		assert.strictEqual(diagnostic.collision!.winnerPath, '/path/a/SKILL.md');
		assert.strictEqual(diagnostic.collision!.loserPath, '/path/b/SKILL.md');
		assert.strictEqual(registry.size, 1); // First registration wins
	});

	it('allows different IDs', () => {
		const comp1 = createTestComponent({ id: 'skill-a', metadata: { name: 'skill-a', description: 'A' } });
		const comp2 = createTestComponent({ id: 'skill-b', metadata: { name: 'skill-b', description: 'B' } });

		registry.register(comp1);
		registry.register(comp2);
		assert.strictEqual(registry.size, 2);
	});
});

// ============================================================================
// Resolution
// ============================================================================

describe('ComponentRegistry — Resolution', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		(registry as any).loaded = true;

		// Register test components
		registry.register(createTestComponent({
			id: 'scout',
			kind: 'agent',
			metadata: { name: 'scout', description: 'Fast recon' },
		}));

		registry.register(createTestComponent({
			id: 'my-plugin:code-review',
			kind: 'skill',
			metadata: { name: 'code-review', namespace: 'my-plugin', description: 'Code review' },
		}));

		registry.register(createTestComponent({
			id: 'security-audit',
			kind: 'skill',
			metadata: { name: 'security-audit', description: 'Security audit' },
		}));
	});

	it('resolves by exact ID', () => {
		const result = registry.resolve('scout');
		assert.ok(result);
		assert.strictEqual(result!.id, 'scout');
	});

	it('resolves namespace-qualified ID', () => {
		const result = registry.resolve('my-plugin:code-review');
		assert.ok(result);
		assert.strictEqual(result!.id, 'my-plugin:code-review');
	});

	it('resolves shorthand (unique bare name)', () => {
		const result = registry.resolve('security-audit');
		assert.ok(result);
		assert.strictEqual(result!.id, 'security-audit');
	});

	it('returns undefined for non-existent component', () => {
		const result = registry.resolve('nonexistent');
		assert.strictEqual(result, undefined);
	});

	it('returns undefined for ambiguous shorthand', () => {
		// Add another component with same bare name but different namespace
		registry.register(createTestComponent({
			id: 'other:code-review',
			kind: 'skill',
			metadata: { name: 'code-review', namespace: 'other', description: 'Another review' },
			filePath: '/other/SKILL.md',
		}));

		// Now 'code-review' is ambiguous (matches both namespaces)
		const result = registry.resolve('code-review');
		assert.strictEqual(result, undefined);
	});
});

// ============================================================================
// Querying
// ============================================================================

describe('ComponentRegistry — Querying', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		(registry as any).loaded = true;

		registry.register(createTestComponent({
			id: 'scout',
			kind: 'agent',
			metadata: { name: 'scout', description: 'Fast recon', tags: ['recon', 'fast'] },
			source: 'user',
		}));

		registry.register(createTestComponent({
			id: 'security-audit',
			kind: 'skill',
			metadata: { name: 'security-audit', description: 'Security scanning', tags: ['security'] },
			source: 'project',
		}));

		registry.register(createTestComponent({
			id: 'test-runner',
			kind: 'skill',
			metadata: { name: 'test-runner', description: 'Runs tests', tags: ['testing'] },
			source: 'user',
			enabled: false,
		}));
	});

	it('lists all components', () => {
		const all = registry.list({ enabledOnly: false });
		assert.strictEqual(all.length, 3);
	});

	it('lists only enabled by default', () => {
		const enabled = registry.list();
		assert.strictEqual(enabled.length, 2);
	});

	it('filters by kind', () => {
		const skills = registry.list({ kind: 'skill', enabledOnly: false });
		assert.strictEqual(skills.length, 2);
		assert.ok(skills.every(c => c.kind === 'skill'));
	});

	it('filters by source', () => {
		const projectOnly = registry.list({ source: 'project', enabledOnly: false });
		assert.strictEqual(projectOnly.length, 1);
		assert.strictEqual(projectOnly[0].source, 'project');
	});

	it('filters by tags', () => {
		const securityTagged = registry.list({ tags: ['security'], enabledOnly: false });
		assert.strictEqual(securityTagged.length, 1);
		assert.strictEqual(securityTagged[0].id, 'security-audit');
	});

	it('searches by text', () => {
		const results = registry.list({ search: 'recon', enabledOnly: false });
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].id, 'scout');
	});

	it('searches case-insensitively', () => {
		const results = registry.list({ search: 'SECURITY', enabledOnly: false });
		assert.strictEqual(results.length, 1);
	});

	it('convenience method: skills()', () => {
		const skills = registry.skills();
		assert.ok(skills.length > 0);
		assert.ok(skills.every(c => c.kind === 'skill'));
	});

	it('convenience method: agents()', () => {
		const agents = registry.agents();
		assert.strictEqual(agents.length, 1);
		assert.strictEqual(agents[0].kind, 'agent');
	});

	it('has() checks existence', () => {
		assert.strictEqual(registry.has('scout'), true);
		assert.strictEqual(registry.has('nonexistent'), false);
	});
});

// ============================================================================
// Enable / Disable
// ============================================================================

describe('ComponentRegistry — Enable/Disable', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		(registry as any).loaded = true;

		registry.register(createTestComponent({ id: 'my-skill' }));
	});

	it('disables a component', () => {
		const result = registry.setEnabled('my-skill', false);
		assert.strictEqual(result, true);

		const component = registry.get('my-skill');
		assert.strictEqual(component!.enabled, false);

		// Should not appear in default list
		assert.strictEqual(registry.list().length, 0);
	});

	it('re-enables a component', () => {
		registry.setEnabled('my-skill', false);
		registry.setEnabled('my-skill', true);

		assert.strictEqual(registry.list().length, 1);
	});

	it('returns false for non-existent component', () => {
		const result = registry.setEnabled('nonexistent', false);
		assert.strictEqual(result, false);
	});
});

// ============================================================================
// Remove
// ============================================================================

describe('ComponentRegistry — Remove', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		(registry as any).loaded = true;

		registry.register(createTestComponent({ id: 'removable' }));
	});

	it('removes a component', () => {
		assert.strictEqual(registry.has('removable'), true);
		const removed = registry.remove('removable');
		assert.strictEqual(removed, true);
		assert.strictEqual(registry.has('removable'), false);
	});

	it('returns false for non-existent removal', () => {
		const removed = registry.remove('nonexistent');
		assert.strictEqual(removed, false);
	});
});

// ============================================================================
// Bridge Methods
// ============================================================================

describe('ComponentRegistry — Bridge Methods', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		(registry as any).loaded = true;

		registry.register(createTestComponent({
			id: 'review',
			kind: 'skill',
			metadata: { name: 'review', description: 'Code review' },
			spec: { prompt: 'SKILL.md', disableModelInvocation: false },
			dirPath: '/skills/review',
			filePath: '/skills/review/SKILL.md',
		}));

		registry.register(createTestComponent({
			id: 'scout',
			kind: 'agent',
			metadata: { name: 'scout', description: 'Fast recon' },
			spec: { systemPrompt: 'scout.md', tools: { allow: ['read', 'grep'] }, model: 'claude-sonnet-4-6' },
			dirPath: '/agents',
			filePath: '/agents/scout.md',
		}));
	});

	it('getSkillsForPrompt returns legacy format', () => {
		const skills = registry.getSkillsForPrompt();
		assert.strictEqual(skills.length, 1);
		assert.strictEqual(skills[0].name, 'review');
		assert.strictEqual(skills[0].description, 'Code review');
		assert.strictEqual(skills[0].baseDir, '/skills/review');
		assert.strictEqual(skills[0].filePath, '/skills/review/SKILL.md');
		assert.strictEqual(skills[0].disableModelInvocation, false);
	});
});

// ============================================================================
// Diagnostics
// ============================================================================

describe('ComponentRegistry — Diagnostics', () => {
	let registry: ComponentRegistry;

	beforeEach(() => {
		resetComponentRegistry();
		registry = new ComponentRegistry('/tmp/test');
		(registry as any).loaded = true;
	});

	it('collects collision diagnostics', () => {
		registry.register(createTestComponent({ id: 'dupe', filePath: '/a/SKILL.md' }));
		registry.register(createTestComponent({ id: 'dupe', filePath: '/b/SKILL.md' }));

		const diagnostics = registry.getDiagnostics();
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].type, 'collision');
	});

	it('getDiagnostics returns copies', () => {
		registry.register(createTestComponent({ id: 'dupe', filePath: '/a/SKILL.md' }));
		registry.register(createTestComponent({ id: 'dupe', filePath: '/b/SKILL.md' }));

		const d1 = registry.getDiagnostics();
		const d2 = registry.getDiagnostics();
		assert.notStrictEqual(d1, d2);
	});
});
