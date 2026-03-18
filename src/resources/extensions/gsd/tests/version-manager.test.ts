import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, compareSemver, satisfiesRange, latestSatisfying, sortVersions } from '../version-manager.js';

describe('parseSemver', () => {
	it('parses valid semver', () => {
		assert.deepStrictEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: undefined });
	});

	it('parses semver with prerelease', () => {
		assert.deepStrictEqual(parseSemver('1.0.0-beta.1'), { major: 1, minor: 0, patch: 0, prerelease: 'beta.1' });
	});

	it('returns null for invalid', () => {
		assert.strictEqual(parseSemver('abc'), null);
		assert.strictEqual(parseSemver('1.2'), null);
		assert.strictEqual(parseSemver(''), null);
	});
});

describe('compareSemver', () => {
	it('equal versions return 0', () => {
		assert.strictEqual(compareSemver('1.2.3', '1.2.3'), 0);
	});

	it('major difference', () => {
		assert.strictEqual(compareSemver('1.0.0', '2.0.0'), -1);
		assert.strictEqual(compareSemver('2.0.0', '1.0.0'), 1);
	});

	it('minor difference', () => {
		assert.strictEqual(compareSemver('1.1.0', '1.2.0'), -1);
	});

	it('patch difference', () => {
		assert.strictEqual(compareSemver('1.2.3', '1.2.4'), -1);
	});

	it('prerelease has lower precedence', () => {
		assert.strictEqual(compareSemver('1.0.0-alpha', '1.0.0'), -1);
		assert.strictEqual(compareSemver('1.0.0', '1.0.0-alpha'), 1);
	});
});

describe('satisfiesRange', () => {
	it('exact match', () => {
		assert.strictEqual(satisfiesRange('1.2.3', '1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.4', '1.2.3'), false);
	});

	it('caret range', () => {
		assert.strictEqual(satisfiesRange('1.2.3', '^1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.9.0', '^1.2.3'), true);
		assert.strictEqual(satisfiesRange('2.0.0', '^1.2.3'), false);
		assert.strictEqual(satisfiesRange('1.2.2', '^1.2.3'), false);
	});

	it('tilde range', () => {
		assert.strictEqual(satisfiesRange('1.2.3', '~1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.9', '~1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.3.0', '~1.2.3'), false);
		assert.strictEqual(satisfiesRange('1.2.2', '~1.2.3'), false);
	});

	it('>= operator', () => {
		assert.strictEqual(satisfiesRange('1.2.3', '>=1.2.3'), true);
		assert.strictEqual(satisfiesRange('2.0.0', '>=1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.2', '>=1.2.3'), false);
	});

	it('> operator', () => {
		assert.strictEqual(satisfiesRange('1.2.4', '>1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.3', '>1.2.3'), false);
	});

	it('<= operator', () => {
		assert.strictEqual(satisfiesRange('1.2.3', '<=1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.4', '<=1.2.3'), false);
	});

	it('< operator', () => {
		assert.strictEqual(satisfiesRange('1.2.2', '<1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.3', '<1.2.3'), false);
	});

	it('= operator', () => {
		assert.strictEqual(satisfiesRange('1.2.3', '=1.2.3'), true);
		assert.strictEqual(satisfiesRange('1.2.4', '=1.2.3'), false);
	});
});

describe('latestSatisfying', () => {
	it('returns latest matching version', () => {
		const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'];
		assert.strictEqual(latestSatisfying(versions, '^1.0.0'), '1.2.0');
	});

	it('returns undefined when none match', () => {
		assert.strictEqual(latestSatisfying(['1.0.0'], '^2.0.0'), undefined);
	});
});

describe('sortVersions', () => {
	it('sorts ascending', () => {
		assert.deepStrictEqual(sortVersions(['2.0.0', '1.0.0', '1.5.0', '1.0.1']), ['1.0.0', '1.0.1', '1.5.0', '2.0.0']);
	});

	it('does not mutate input', () => {
		const input = ['2.0.0', '1.0.0'];
		sortVersions(input);
		assert.deepStrictEqual(input, ['2.0.0', '1.0.0']);
	});
});
