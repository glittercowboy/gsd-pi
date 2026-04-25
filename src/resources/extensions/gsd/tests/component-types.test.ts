/**
 * Component Types — Unit Tests
 *
 * Tests for validation utilities and helper functions in component-types.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	validateComponentName,
	validateComponentDescription,
	computeComponentId,
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
} from '../component-types.js';

// ============================================================================
// validateComponentName
// ============================================================================

describe('validateComponentName', () => {
	it('accepts valid names', () => {
		assert.deepStrictEqual(validateComponentName('my-skill'), []);
		assert.deepStrictEqual(validateComponentName('scout'), []);
		assert.deepStrictEqual(validateComponentName('db-migrator-postgres'), []);
		assert.deepStrictEqual(validateComponentName('a1'), []);
		assert.deepStrictEqual(validateComponentName('tool-123'), []);
	});

	it('rejects empty names', () => {
		const errors = validateComponentName('');
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('required'));
	});

	it('rejects names with uppercase', () => {
		const errors = validateComponentName('MySkill');
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('lowercase'));
	});

	it('rejects names starting with hyphen', () => {
		const errors = validateComponentName('-scout');
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('hyphen'));
	});

	it('rejects names ending with hyphen', () => {
		const errors = validateComponentName('scout-');
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('hyphen'));
	});

	it('rejects names with consecutive hyphens', () => {
		const errors = validateComponentName('my--skill');
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('consecutive'));
	});

	it('rejects names with invalid characters', () => {
		const errors = validateComponentName('my_skill');
		assert.ok(errors.length > 0);
	});

	it('rejects names exceeding max length', () => {
		const longName = 'a'.repeat(MAX_NAME_LENGTH + 1);
		const errors = validateComponentName(longName);
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('exceeds'));
	});

	it('accepts names at exactly max length', () => {
		const exactName = 'a'.repeat(MAX_NAME_LENGTH);
		assert.deepStrictEqual(validateComponentName(exactName), []);
	});
});

// ============================================================================
// validateComponentDescription
// ============================================================================

describe('validateComponentDescription', () => {
	it('accepts valid descriptions', () => {
		assert.deepStrictEqual(validateComponentDescription('A useful skill'), []);
	});

	it('rejects empty descriptions', () => {
		const errors = validateComponentDescription('');
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('required'));
	});

	it('rejects undefined descriptions', () => {
		const errors = validateComponentDescription(undefined);
		assert.ok(errors.length > 0);
	});

	it('rejects whitespace-only descriptions', () => {
		const errors = validateComponentDescription('   ');
		assert.ok(errors.length > 0);
	});

	it('rejects descriptions exceeding max length', () => {
		const longDesc = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1);
		const errors = validateComponentDescription(longDesc);
		assert.ok(errors.length > 0);
		assert.ok(errors[0].includes('exceeds'));
	});
});

// ============================================================================
// computeComponentId
// ============================================================================

describe('computeComponentId', () => {
	it('returns bare name when no namespace', () => {
		assert.strictEqual(computeComponentId('scout'), 'scout');
	});

	it('returns namespace:name when namespace provided', () => {
		assert.strictEqual(computeComponentId('code-review', 'my-plugin'), 'my-plugin:code-review');
	});

	it('handles undefined namespace same as no namespace', () => {
		assert.strictEqual(computeComponentId('scout', undefined), 'scout');
	});
});
