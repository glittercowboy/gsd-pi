/**
 * Component Loader — Unit Tests
 *
 * Tests for multi-format component loading:
 * - New format (component.yaml)
 * - Legacy skill format (SKILL.md with frontmatter)
 * - Legacy agent format (.md with frontmatter)
 * - Directory scanning
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	loadComponentFromDir,
	loadComponentFromAgentFile,
	scanComponentDir,
	scanAgentDir,
} from '../component-loader.js';

// ============================================================================
// Test Fixtures
// ============================================================================

let testDir: string;

function setupTestDir(): string {
	const dir = join(tmpdir(), `gsd-component-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupTestDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// loadComponentFromDir — New Format
// ============================================================================

describe('loadComponentFromDir (component.yaml)', () => {
	beforeEach(() => {
		testDir = setupTestDir();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	it('loads a valid skill component.yaml', () => {
		const skillDir = join(testDir, 'my-skill');
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: my-skill
  description: "A test skill"
  version: 1.0.0
  tags: [test, demo]
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(skillDir, 'SKILL.md'), 'You are a test skill.', 'utf-8');

		const result = loadComponentFromDir(skillDir, 'user');
		assert.ok(result.component, 'should load component');
		assert.strictEqual(result.component!.kind, 'skill');
		assert.strictEqual(result.component!.id, 'my-skill');
		assert.strictEqual(result.component!.metadata.description, 'A test skill');
		assert.strictEqual(result.component!.metadata.version, '1.0.0');
		assert.deepStrictEqual(result.component!.metadata.tags, ['test', 'demo']);
		assert.strictEqual(result.component!.format, 'component-yaml');
		assert.strictEqual(result.component!.source, 'user');
		assert.strictEqual(result.component!.enabled, true);
	});

	it('loads a valid agent component.yaml', () => {
		const agentDir = join(testDir, 'my-agent');
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, 'component.yaml'), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: my-agent
  description: "A test agent"
spec:
  systemPrompt: AGENT.md
  model: claude-sonnet-4-6
  tools:
    allow: [bash, read, grep]
  maxTurns: 20
  timeoutMinutes: 5
`, 'utf-8');
		writeFileSync(join(agentDir, 'AGENT.md'), 'You are a test agent.', 'utf-8');

		const result = loadComponentFromDir(agentDir, 'project');
		assert.ok(result.component);
		assert.strictEqual(result.component!.kind, 'agent');
		assert.strictEqual(result.component!.id, 'my-agent');
		assert.strictEqual(result.component!.source, 'project');
		assert.strictEqual(result.component!.format, 'component-yaml');

		const spec = result.component!.spec as any;
		assert.strictEqual(spec.model, 'claude-sonnet-4-6');
		assert.deepStrictEqual(spec.tools.allow, ['bash', 'read', 'grep']);
		assert.strictEqual(spec.maxTurns, 20);
	});

	it('loads component with namespace', () => {
		const dir = join(testDir, 'code-review');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: code-review
  namespace: my-plugin
  description: "Code review skill"
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(dir, 'SKILL.md'), 'Review code.', 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.ok(result.component);
		assert.strictEqual(result.component!.id, 'my-plugin:code-review');
		assert.strictEqual(result.component!.metadata.namespace, 'my-plugin');
	});

	it('returns error for missing apiVersion', () => {
		const dir = join(testDir, 'bad-skill');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
kind: skill
metadata:
  name: bad-skill
  description: "Missing apiVersion"
spec:
  prompt: SKILL.md
`, 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
		assert.ok(result.diagnostics.some(d => d.message.includes('apiVersion')));
	});

	it('returns error for unsupported apiVersion', () => {
		const dir = join(testDir, 'bad-version');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v2
kind: skill
metadata:
  name: bad-version
  description: "Unsupported apiVersion"
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(dir, 'SKILL.md'), 'Content.', 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
		assert.ok(result.diagnostics.some(d => d.type === 'error' && d.message.includes('unsupported apiVersion')));
	});

	it('returns error for missing metadata.name', () => {
		const dir = join(testDir, 'no-name');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  description: "No name"
spec:
  prompt: SKILL.md
`, 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
	});

	it('returns error for invalid component.yaml metadata', () => {
		const dir = join(testDir, 'bad-metadata');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: BadName
  description: "Invalid uppercase name"
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(dir, 'SKILL.md'), 'Content.', 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
		assert.ok(result.diagnostics.some(d => d.type === 'error' && d.message.includes('lowercase')));
	});

	it('returns error for invalid YAML', () => {
		const dir = join(testDir, 'bad-yaml');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), '{{{{invalid yaml', 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
		assert.ok(result.diagnostics.some(d => d.type === 'error'));
	});

	it('returns error when a component.yaml skill prompt file is missing', () => {
		const dir = join(testDir, 'missing-prompt');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: missing-prompt
  description: "Missing prompt file"
spec:
  prompt: SKILL.md
`, 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
		assert.ok(result.diagnostics.some(d => d.type === 'error' && d.message.includes('missing referenced file')));
	});

	it('rejects unsupported component kinds in this slice', () => {
		const dir = join(testDir, 'workflow');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: pipeline
metadata:
  name: workflow
  description: "Not supported by this PR"
spec:
  steps: []
`, 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.strictEqual(result.component, null);
		assert.ok(result.diagnostics.some(d => d.message.includes('unsupported kind')));
	});
});

// ============================================================================
// loadComponentFromDir — Legacy Skill Format
// ============================================================================

describe('loadComponentFromDir (legacy SKILL.md)', () => {
	beforeEach(() => {
		testDir = setupTestDir();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	it('loads a legacy skill with frontmatter', () => {
		const skillDir = join(testDir, 'review');
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, 'SKILL.md'), `---
name: review
description: Reviews code for quality
---

You are a code reviewer.
`, 'utf-8');

		const result = loadComponentFromDir(skillDir, 'user');
		assert.ok(result.component);
		assert.strictEqual(result.component!.kind, 'skill');
		assert.strictEqual(result.component!.id, 'review');
		assert.strictEqual(result.component!.metadata.description, 'Reviews code for quality');
		assert.strictEqual(result.component!.format, 'skill-md');
	});

	it('uses parent directory name when name missing from frontmatter', () => {
		const skillDir = join(testDir, 'my-custom');
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, 'SKILL.md'), `---
description: A custom skill
---

Content here.
`, 'utf-8');

		const result = loadComponentFromDir(skillDir, 'project');
		assert.ok(result.component);
		assert.strictEqual(result.component!.id, 'my-custom');
	});

	it('returns null when description is missing', () => {
		const skillDir = join(testDir, 'no-desc');
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, 'SKILL.md'), `---
name: no-desc
---

No description.
`, 'utf-8');

		const result = loadComponentFromDir(skillDir, 'user');
		assert.strictEqual(result.component, null);
	});

	it('prefers component.yaml over SKILL.md when both exist', () => {
		const dir = join(testDir, 'dual-format');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: dual-format
  description: "From component.yaml"
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(dir, 'SKILL.md'), `---
name: dual-format
description: From SKILL.md frontmatter
---

Content.
`, 'utf-8');

		const result = loadComponentFromDir(dir, 'user');
		assert.ok(result.component);
		assert.strictEqual(result.component!.metadata.description, 'From component.yaml');
		assert.strictEqual(result.component!.format, 'component-yaml');
	});
});

// ============================================================================
// loadComponentFromAgentFile — Legacy Agent Format
// ============================================================================

describe('loadComponentFromAgentFile (legacy agent .md)', () => {
	beforeEach(() => {
		testDir = setupTestDir();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	it('loads a legacy agent file', () => {
		const agentFile = join(testDir, 'scout.md');
		writeFileSync(agentFile, `---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
---

You are a scout.
`, 'utf-8');

		const result = loadComponentFromAgentFile(agentFile, 'user');
		assert.ok(result.component);
		assert.strictEqual(result.component!.kind, 'agent');
		assert.strictEqual(result.component!.id, 'scout');
		assert.strictEqual(result.component!.format, 'agent-md');

		const spec = result.component!.spec as any;
		assert.deepStrictEqual(spec.tools.allow, ['read', 'grep', 'find', 'ls', 'bash']);
	});

	it('loads agent with model override', () => {
		const agentFile = join(testDir, 'smart-agent.md');
		writeFileSync(agentFile, `---
name: smart-agent
description: Uses a specific model
model: claude-opus-4-6
tools: bash, read
---

You are smart.
`, 'utf-8');

		const result = loadComponentFromAgentFile(agentFile, 'user');
		assert.ok(result.component);

		const spec = result.component!.spec as any;
		assert.strictEqual(spec.model, 'claude-opus-4-6');
	});

	it('returns null when name is missing', () => {
		const agentFile = join(testDir, 'no-name.md');
		writeFileSync(agentFile, `---
description: Missing name
---

Content.
`, 'utf-8');

		const result = loadComponentFromAgentFile(agentFile, 'user');
		assert.strictEqual(result.component, null);
	});
});

// ============================================================================
// scanComponentDir
// ============================================================================

describe('scanComponentDir', () => {
	beforeEach(() => {
		testDir = setupTestDir();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	it('scans directory with multiple components', () => {
		// Create two skill directories
		const skill1Dir = join(testDir, 'skill-a');
		mkdirSync(skill1Dir, { recursive: true });
		writeFileSync(join(skill1Dir, 'SKILL.md'), `---
name: skill-a
description: First skill
---
Content.
`, 'utf-8');

		const skill2Dir = join(testDir, 'skill-b');
		mkdirSync(skill2Dir, { recursive: true });
		writeFileSync(join(skill2Dir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: skill-b
  description: "Second skill"
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(skill2Dir, 'SKILL.md'), 'Content.', 'utf-8');

		const result = scanComponentDir(testDir, 'user');
		assert.strictEqual(result.components.length, 2);

		const names = result.components.map(c => c.id).sort();
		assert.deepStrictEqual(names, ['skill-a', 'skill-b']);
	});

	it('filters by kind when specified', () => {
		// Create a skill and an agent
		const skillDir = join(testDir, 'my-skill');
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, 'component.yaml'), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: my-skill
  description: "A skill"
spec:
  prompt: SKILL.md
`, 'utf-8');
		writeFileSync(join(skillDir, 'SKILL.md'), 'Skill content.', 'utf-8');

		const agentDir = join(testDir, 'my-agent');
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, 'component.yaml'), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: my-agent
  description: "An agent"
spec:
  systemPrompt: AGENT.md
`, 'utf-8');
		writeFileSync(join(agentDir, 'AGENT.md'), 'Agent content.', 'utf-8');

		const skillsOnly = scanComponentDir(testDir, 'user', 'skill');
		assert.strictEqual(skillsOnly.components.length, 1);
		assert.strictEqual(skillsOnly.components[0].kind, 'skill');

		const agentsOnly = scanComponentDir(testDir, 'user', 'agent');
		assert.strictEqual(agentsOnly.components.length, 1);
		assert.strictEqual(agentsOnly.components[0].kind, 'agent');
	});

	it('skips hidden directories', () => {
		const hiddenDir = join(testDir, '.hidden');
		mkdirSync(hiddenDir, { recursive: true });
		writeFileSync(join(hiddenDir, 'SKILL.md'), `---
name: hidden
description: Should be skipped
---
`, 'utf-8');

		const result = scanComponentDir(testDir, 'user');
		assert.strictEqual(result.components.length, 0);
	});

	it('returns empty for non-existent directory', () => {
		const result = scanComponentDir(join(testDir, 'nonexistent-dir-xyz'), 'user');
		assert.strictEqual(result.components.length, 0);
		assert.strictEqual(result.diagnostics.length, 0);
	});
});

// ============================================================================
// scanAgentDir
// ============================================================================

describe('scanAgentDir', () => {
	beforeEach(() => {
		testDir = setupTestDir();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	it('discovers agent .md files', () => {
		writeFileSync(join(testDir, 'scout.md'), `---
name: scout
description: Fast recon
tools: read, grep
---
You are a scout.
`, 'utf-8');

		writeFileSync(join(testDir, 'worker.md'), `---
name: worker
description: General worker
---
You are a worker.
`, 'utf-8');

		const result = scanAgentDir(testDir, 'user');
		assert.strictEqual(result.components.length, 2);
		assert.ok(result.components.every(c => c.kind === 'agent'));
	});

	it('prefers component.yaml directory over same-named .md file', () => {
		// Create both formats for same agent
		writeFileSync(join(testDir, 'scout.md'), `---
name: scout
description: From .md file
tools: read
---
Old format.
`, 'utf-8');

		const scoutDir = join(testDir, 'scout');
		mkdirSync(scoutDir, { recursive: true });
		writeFileSync(join(scoutDir, 'component.yaml'), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: scout
  description: "From component.yaml"
spec:
  systemPrompt: AGENT.md
`, 'utf-8');
		writeFileSync(join(scoutDir, 'AGENT.md'), 'New format.', 'utf-8');

		const result = scanAgentDir(testDir, 'user');
		assert.strictEqual(result.components.length, 1);
		assert.strictEqual(result.components[0].metadata.description, 'From component.yaml');
		assert.strictEqual(result.components[0].format, 'component-yaml');
	});

	it('discovers standalone component.yaml agent directories', () => {
		const scoutDir = join(testDir, 'scout');
		mkdirSync(scoutDir, { recursive: true });
		writeFileSync(join(scoutDir, 'component.yaml'), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: scout
  description: "From component.yaml"
spec:
  systemPrompt: AGENT.md
`, 'utf-8');
		writeFileSync(join(scoutDir, 'AGENT.md'), 'New format.', 'utf-8');

		const result = scanAgentDir(testDir, 'user');
		assert.strictEqual(result.components.length, 1);
		assert.strictEqual(result.components[0].kind, 'agent');
		assert.strictEqual(result.components[0].format, 'component-yaml');
	});
});
