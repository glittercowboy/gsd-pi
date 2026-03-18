import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarketplaceStore } from '../marketplace-store.js';

function makeTmpDir(): string {
	const dir = join(tmpdir(), `marketplace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function createComponentDir(base: string, name: string, kind: string, description: string): string {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'component.yaml'), [
		'apiVersion: gsd/v1',
		`kind: ${kind}`,
		'metadata:',
		`  name: ${name}`,
		`  description: "${description}"`,
		'  version: 1.0.0',
		'spec:',
		kind === 'skill' ? '  prompt: SKILL.md' : '  systemPrompt: AGENT.md',
	].join('\n'), 'utf-8');
	if (kind === 'skill') {
		writeFileSync(join(dir, 'SKILL.md'), 'Test skill content', 'utf-8');
	} else {
		writeFileSync(join(dir, 'AGENT.md'), 'Test agent content', 'utf-8');
	}
	return dir;
}

describe('MarketplaceStore', () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		configPath = join(tmpDir, 'marketplace-sources.yaml');
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('starts with empty sources when config does not exist', () => {
		const store = new MarketplaceStore(configPath);
		assert.deepStrictEqual(store.getSources(), []);
	});

	it('addSource and getSources', () => {
		const store = new MarketplaceStore(configPath);
		store.addSource({ name: 'local-test', type: 'local', path: '/tmp/test', trust: 'community' });
		const sources = store.getSources();
		assert.strictEqual(sources.length, 1);
		assert.strictEqual(sources[0].name, 'local-test');
	});

	it('removeSource returns true when found', () => {
		const store = new MarketplaceStore(configPath);
		store.addSource({ name: 'to-remove', type: 'local', path: '/tmp', trust: 'community' });
		assert.strictEqual(store.removeSource('to-remove'), true);
		assert.strictEqual(store.getSources().length, 0);
	});

	it('removeSource returns false when not found', () => {
		const store = new MarketplaceStore(configPath);
		assert.strictEqual(store.removeSource('nonexistent'), false);
	});

	it('persists sources across instances', () => {
		const store1 = new MarketplaceStore(configPath);
		store1.addSource({ name: 'persisted', type: 'local', path: '/tmp', trust: 'trusted' });

		const store2 = new MarketplaceStore(configPath);
		assert.strictEqual(store2.getSources().length, 1);
		assert.strictEqual(store2.getSources()[0].name, 'persisted');
	});

	it('search finds components in local source', () => {
		const sourceDir = join(tmpDir, 'source-repo');
		mkdirSync(sourceDir, { recursive: true });
		createComponentDir(sourceDir, 'my-skill', 'skill', 'A test skill for searching');

		const store = new MarketplaceStore(configPath);
		store.addSource({ name: 'test-source', type: 'local', path: sourceDir, trust: 'community' });

		const results = store.search('test');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].name, 'my-skill');
		assert.strictEqual(results[0].kind, 'skill');
	});

	it('search filters by kind', () => {
		const sourceDir = join(tmpDir, 'source-repo');
		mkdirSync(sourceDir, { recursive: true });
		createComponentDir(sourceDir, 'my-skill', 'skill', 'A test skill');
		createComponentDir(sourceDir, 'my-agent', 'agent', 'A test agent');

		const store = new MarketplaceStore(configPath);
		store.addSource({ name: 'test-source', type: 'local', path: sourceDir, trust: 'community' });

		const skillResults = store.search('test', 'skill');
		assert.strictEqual(skillResults.length, 1);
		assert.strictEqual(skillResults[0].kind, 'skill');
	});

	it('install copies component from local source', () => {
		const sourceDir = join(tmpDir, 'source-repo');
		mkdirSync(sourceDir, { recursive: true });
		createComponentDir(sourceDir, 'installable', 'skill', 'An installable skill');

		const installDir = join(tmpDir, 'install-target');
		mkdirSync(join(installDir, '.gsd'), { recursive: true });

		const store = new MarketplaceStore(configPath);
		store.addSource({ name: 'test-source', type: 'local', path: sourceDir, trust: 'community' });

		const result = store.install('installable', { scope: 'project', cwd: installDir });
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.componentId, 'installable');
		assert.ok(result.installedPath);
		assert.ok(existsSync(result.installedPath!));
	});

	it('install returns error for not found component', () => {
		const store = new MarketplaceStore(configPath);
		const result = store.install('nonexistent');
		assert.strictEqual(result.success, false);
		assert.ok(result.error?.includes('not found'));
	});

	it('uninstall removes installed component', () => {
		const installBase = join(tmpDir, 'uninstall-target');
		const skillsDir = join(installBase, '.gsd', 'skills', 'to-remove');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'component.yaml'), 'test', 'utf-8');

		const store = new MarketplaceStore(configPath);
		const removed = store.uninstall('to-remove', { scope: 'project', cwd: installBase });
		assert.strictEqual(removed, true);
		assert.strictEqual(existsSync(skillsDir), false);
	});

	it('uninstall returns false when component not found', () => {
		const store = new MarketplaceStore(configPath);
		const removed = store.uninstall('nonexistent', { scope: 'project', cwd: tmpDir });
		assert.strictEqual(removed, false);
	});
});
