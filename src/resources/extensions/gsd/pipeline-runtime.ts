/**
 * Pipeline Runtime
 *
 * Executes pipeline specifications by validating, planning, and running
 * steps in wave order. Steps are recorded as 'pending' since actual agent
 * invocation requires integration with the subagent system.
 */

import type { Component, PipelineSpec } from './component-types.js';
import type { ComponentRegistry } from './component-registry.js';
import {
	validatePipelineSpec,
	buildExecutionPlan,
	interpolateVariables,
} from './pipeline-parser.js';

// ============================================================================
// Types
// ============================================================================

export interface StepResult {
	stepId: string;
	component: string;
	task: string;
	status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
	output?: string;
	durationMs?: number;
	error?: string;
}

export interface PipelineResult {
	pipelineId: string;
	status: 'pending' | 'running' | 'completed' | 'failed';
	waves: Array<{ waveIndex: number; steps: StepResult[] }>;
	outputs: Record<string, string>;
	totalDurationMs: number;
	errors: string[];
}

// ============================================================================
// Pipeline Runner
// ============================================================================

export class PipelineRunner {
	private registry: ComponentRegistry;

	constructor(registry: ComponentRegistry) {
		this.registry = registry;
	}

	/**
	 * Execute a pipeline component.
	 *
	 * Validates the spec, applies input defaults, builds an execution plan,
	 * and records what each step would invoke. Steps are marked as 'pending'
	 * since actual agent invocation is not wired up yet.
	 */
	run(pipeline: Component, inputs?: Record<string, string | number | boolean>): PipelineResult {
		const startTime = Date.now();
		const spec = pipeline.spec as PipelineSpec;

		const result: PipelineResult = {
			pipelineId: pipeline.id,
			status: 'running',
			waves: [],
			outputs: {},
			totalDurationMs: 0,
			errors: [],
		};

		// Validate the pipeline spec
		const validation = validatePipelineSpec(spec);
		if (!validation.valid) {
			result.status = 'failed';
			result.errors = validation.errors;
			result.totalDurationMs = Date.now() - startTime;
			return result;
		}

		// Resolve inputs: merge provided values with defaults
		const resolvedInputs: Record<string, string> = {};
		if (spec.inputs) {
			for (const [key, inputDef] of Object.entries(spec.inputs)) {
				const provided = inputs?.[key];
				if (provided !== undefined) {
					resolvedInputs[key] = String(provided);
				} else if (inputDef.default !== undefined) {
					resolvedInputs[key] = String(inputDef.default);
				}
			}
		}

		// Build execution plan
		const waves = buildExecutionPlan(spec);

		// Build interpolation context with input values
		const context: Record<string, string> = {};
		for (const [key, value] of Object.entries(resolvedInputs)) {
			context[`inputs.${key}`] = value;
		}

		let previousOutput: string | undefined;

		// Process each wave
		for (const wave of waves) {
			const waveResults: StepResult[] = [];

			for (const step of wave.steps) {
				const stepStart = Date.now();

				// Add {previous} to context if available
				if (previousOutput !== undefined) {
					context['previous'] = previousOutput;
				}

				// Interpolate the task string
				const interpolatedTask = interpolateVariables(step.task, context);

				const stepResult: StepResult = {
					stepId: step.id,
					component: step.component,
					task: interpolatedTask,
					status: 'pending',
					durationMs: Date.now() - stepStart,
				};

				// Record output variable if defined
				if (step.output) {
					const outputValue = `[output:${step.id}]`;
					context[`${step.id}.output`] = outputValue;
					stepResult.output = outputValue;
					previousOutput = outputValue;
				}

				waveResults.push(stepResult);
			}

			result.waves.push({ waveIndex: wave.waveIndex, steps: waveResults });
		}

		// Map pipeline outputs
		if (spec.outputs) {
			for (const [key, ref] of Object.entries(spec.outputs)) {
				const value = interpolateVariables(ref, context);
				result.outputs[key] = value;
			}
		}

		result.status = 'completed';
		result.totalDurationMs = Date.now() - startTime;
		return result;
	}
}
