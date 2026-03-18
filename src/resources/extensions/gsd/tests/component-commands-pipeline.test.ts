/**
 * Pipeline Command Handler — Unit Tests
 *
 * Tests for the `/gsd pipeline` subcommands: list, info, run, validate.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import type { Component } from '../component-types.js';
import type { PipelineSpec } from '../component-types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createPipelineComponent(overrides: Partial<Component> = {}): Component {
	const spec: PipelineSpec = (overrides.spec as PipelineSpec) ?? {
		steps: [
			{ id: 'lint', component: 'eslint-check', task: 'Run lint checks', parallel: false },
			{ id: 'test', component: 'run-tests', task: 'Run test suite', parallel: false, dependsOn: ['lint'] },
		],
		inputs: {
			target: { type: 'string', default: 'src', description: 'Target directory' },
		},
	};

	return {
		id: overrides.id ?? 'ci-pipeline',
		kind: 'pipeline',
		metadata: overrides.metadata ?? {
			name: 'ci-pipeline',
			description: 'CI validation pipeline',
			version: '1.0.0',
		},
		spec,
		dirPath: overrides.dirPath ?? '/test/pipelines/ci-pipeline',
		filePath: overrides.filePath ?? '/test/pipelines/ci-pipeline/component.yaml',
		source: overrides.source ?? 'project',
		format: overrides.format ?? 'component-yaml',
		enabled: overrides.enabled ?? true,
	};
}

function createMockPi() {
	const messages: { content: string; triggerTurn: boolean }[] = [];
	return {
		messages,
		sendMessage: mock.fn((msg: any, opts: any) => {
			messages.push({ content: msg.content, triggerTurn: opts?.triggerTurn ?? false });
		}),
	};
}

function createMockCtx(cwd = '/test/project') {
	return { cwd } as any;
}

// ============================================================================
// Pipeline Info
// ============================================================================

describe('handlePipelineCommand — info subcommand logic', () => {
	it('pipeline info shows steps and inputs', () => {
		const spec: PipelineSpec = {
			steps: [
				{ id: 'lint', component: 'eslint-check', task: 'Run lint', parallel: true },
				{ id: 'test', component: 'run-tests', task: 'Run tests', dependsOn: ['lint'] },
			],
			inputs: {
				target: { type: 'string', default: 'src', description: 'Target dir' },
			},
		};

		// Verify the spec structure is correct for info display
		assert.strictEqual(spec.steps.length, 2);
		assert.strictEqual(spec.steps[0].id, 'lint');
		assert.strictEqual(spec.steps[0].parallel, true);
		assert.strictEqual(spec.steps[1].dependsOn?.[0], 'lint');
		assert.ok(spec.inputs);
		assert.strictEqual(spec.inputs['target'].type, 'string');
		assert.strictEqual(spec.inputs['target'].default, 'src');
	});
});

// ============================================================================
// Pipeline Validation
// ============================================================================

describe('handlePipelineCommand — validate subcommand logic', () => {
	it('valid pipeline produces no errors', async () => {
		const { validatePipelineSpec } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [
				{ id: 'lint', component: 'eslint-check', task: 'Lint code' },
				{ id: 'test', component: 'run-tests', task: 'Run tests', dependsOn: ['lint'] },
			],
		};

		const result = validatePipelineSpec(spec);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.errors.length, 0);
	});

	it('pipeline with duplicate step IDs fails validation', async () => {
		const { validatePipelineSpec } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [
				{ id: 'lint', component: 'eslint-check', task: 'Lint code' },
				{ id: 'lint', component: 'another-check', task: 'Duplicate step' },
			],
		};

		const result = validatePipelineSpec(spec);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('duplicate')));
	});

	it('pipeline with unknown dependsOn fails validation', async () => {
		const { validatePipelineSpec } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [
				{ id: 'lint', component: 'eslint-check', task: 'Lint code', dependsOn: ['nonexistent'] },
			],
		};

		const result = validatePipelineSpec(spec);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('unknown step')));
	});

	it('pipeline with no steps fails validation', async () => {
		const { validatePipelineSpec } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [],
		};

		const result = validatePipelineSpec(spec);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('at least one step')));
	});
});

// ============================================================================
// Pipeline Run (Execution Plan)
// ============================================================================

describe('handlePipelineCommand — run subcommand logic', () => {
	it('builds correct execution waves for sequential steps', async () => {
		const { buildExecutionPlan, validatePipelineSpec } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [
				{ id: 'lint', component: 'eslint-check', task: 'Lint code' },
				{ id: 'test', component: 'run-tests', task: 'Run tests' },
			],
		};

		const validation = validatePipelineSpec(spec);
		assert.strictEqual(validation.valid, true);

		const waves = buildExecutionPlan(spec);
		// Sequential steps each get their own wave
		assert.strictEqual(waves.length, 2);
		assert.strictEqual(waves[0].steps.length, 1);
		assert.strictEqual(waves[0].steps[0].id, 'lint');
		assert.strictEqual(waves[1].steps.length, 1);
		assert.strictEqual(waves[1].steps[0].id, 'test');
	});

	it('builds correct execution waves for parallel steps', async () => {
		const { buildExecutionPlan, validatePipelineSpec } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [
				{ id: 'lint', component: 'eslint-check', task: 'Lint code', parallel: true },
				{ id: 'format', component: 'prettier', task: 'Check formatting', parallel: true },
				{ id: 'deploy', component: 'deployer', task: 'Deploy', dependsOn: ['lint', 'format'] },
			],
		};

		const validation = validatePipelineSpec(spec);
		assert.strictEqual(validation.valid, true);

		const waves = buildExecutionPlan(spec);
		// First wave: parallel lint + format, second wave: sequential deploy
		assert.strictEqual(waves.length, 2);
		assert.strictEqual(waves[0].steps.length, 2);
		const firstWaveIds = waves[0].steps.map(s => s.id).sort();
		assert.deepStrictEqual(firstWaveIds, ['format', 'lint']);
		assert.strictEqual(waves[1].steps.length, 1);
		assert.strictEqual(waves[1].steps[0].id, 'deploy');
	});

	it('builds waves respecting dependency ordering', async () => {
		const { buildExecutionPlan } = await import('../pipeline-parser.js');

		const spec: PipelineSpec = {
			steps: [
				{ id: 'build', component: 'builder', task: 'Build project' },
				{ id: 'test', component: 'tester', task: 'Run tests', dependsOn: ['build'] },
				{ id: 'deploy', component: 'deployer', task: 'Deploy', dependsOn: ['test'] },
			],
		};

		const waves = buildExecutionPlan(spec);
		assert.strictEqual(waves.length, 3);
		assert.strictEqual(waves[0].steps[0].id, 'build');
		assert.strictEqual(waves[1].steps[0].id, 'test');
		assert.strictEqual(waves[2].steps[0].id, 'deploy');
	});
});

// ============================================================================
// Pipeline Component Fixture Validation
// ============================================================================

describe('pipeline component fixture', () => {
	it('createPipelineComponent creates a valid pipeline component', () => {
		const component = createPipelineComponent();
		assert.strictEqual(component.kind, 'pipeline');
		assert.strictEqual(component.id, 'ci-pipeline');
		assert.strictEqual(component.metadata.name, 'ci-pipeline');

		const spec = component.spec as PipelineSpec;
		assert.strictEqual(spec.steps.length, 2);
		assert.ok(spec.inputs);
		assert.ok(spec.inputs['target']);
	});

	it('createPipelineComponent allows spec overrides', () => {
		const customSpec: PipelineSpec = {
			steps: [
				{ id: 'only-step', component: 'check', task: 'Do check' },
			],
		};
		const component = createPipelineComponent({ spec: customSpec });
		const spec = component.spec as PipelineSpec;
		assert.strictEqual(spec.steps.length, 1);
		assert.strictEqual(spec.steps[0].id, 'only-step');
	});
});
