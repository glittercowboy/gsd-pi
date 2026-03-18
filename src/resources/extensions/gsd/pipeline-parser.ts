/**
 * Pipeline Parser
 *
 * Validates pipeline specifications, builds execution plans from DAGs,
 * and handles variable interpolation for pipeline step tasks.
 */

import type { PipelineSpec, PipelineStep } from './component-types.js';

// ============================================================================
// Types
// ============================================================================

export interface ExecutionWave {
	waveIndex: number;
	steps: PipelineStep[];
}

export interface PipelineValidation {
	valid: boolean;
	errors: string[];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a pipeline specification for structural correctness.
 * Checks unique step IDs, valid dependsOn references, circular dependencies,
 * and non-empty component references.
 */
export function validatePipelineSpec(spec: PipelineSpec): PipelineValidation {
	const errors: string[] = [];

	if (!spec.steps || spec.steps.length === 0) {
		errors.push('pipeline must have at least one step');
		return { valid: false, errors };
	}

	// Check for unique step IDs
	const ids = new Set<string>();
	for (const step of spec.steps) {
		if (ids.has(step.id)) {
			errors.push(`duplicate step id: "${step.id}"`);
		}
		ids.add(step.id);
	}

	// Check component references are not empty
	for (const step of spec.steps) {
		if (!step.component || step.component.trim() === '') {
			errors.push(`step "${step.id}" has empty component reference`);
		}
	}

	// Check dependsOn references exist
	for (const step of spec.steps) {
		if (step.dependsOn) {
			for (const dep of step.dependsOn) {
				if (!ids.has(dep)) {
					errors.push(`step "${step.id}" depends on unknown step "${dep}"`);
				}
			}
		}
	}

	// Detect circular dependencies
	const circularError = detectCircularDependencies(spec.steps);
	if (circularError) {
		errors.push(circularError);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Detect circular dependencies in the step DAG using depth-first search.
 * Returns an error message if a cycle is found, or null if the graph is acyclic.
 */
function detectCircularDependencies(steps: PipelineStep[]): string | null {
	const adjacency = new Map<string, string[]>();
	for (const step of steps) {
		adjacency.set(step.id, step.dependsOn ?? []);
	}

	const visited = new Set<string>();
	const inStack = new Set<string>();

	function dfs(nodeId: string): string | null {
		if (inStack.has(nodeId)) {
			return `circular dependency detected involving step "${nodeId}"`;
		}
		if (visited.has(nodeId)) {
			return null;
		}

		visited.add(nodeId);
		inStack.add(nodeId);

		const deps = adjacency.get(nodeId) ?? [];
		for (const dep of deps) {
			const result = dfs(dep);
			if (result) return result;
		}

		inStack.delete(nodeId);
		return null;
	}

	for (const step of steps) {
		const result = dfs(step.id);
		if (result) return result;
	}

	return null;
}

// ============================================================================
// Execution Plan
// ============================================================================

/**
 * Build an execution plan from a pipeline spec.
 * Converts steps into ordered waves where each wave's steps can run in parallel.
 *
 * Rules:
 * - Sequential steps (parallel !== true) go in their own wave
 * - Parallel steps with no unmet dependencies group together
 * - Steps with dependsOn wait until all dependencies have been scheduled
 */
export function buildExecutionPlan(spec: PipelineSpec): ExecutionWave[] {
	const waves: ExecutionWave[] = [];
	const scheduled = new Set<string>();

	// Build a lookup for quick access
	const stepMap = new Map<string, PipelineStep>();
	for (const step of spec.steps) {
		stepMap.set(step.id, step);
	}

	const remaining = [...spec.steps];

	while (remaining.length > 0) {
		// Find all steps whose dependencies are met
		const ready: PipelineStep[] = [];
		const notReady: PipelineStep[] = [];

		for (const step of remaining) {
			const depsResolved = !step.dependsOn || step.dependsOn.every(d => scheduled.has(d));
			if (depsResolved) {
				ready.push(step);
			} else {
				notReady.push(step);
			}
		}

		if (ready.length === 0) {
			// All remaining steps have unresolved deps (shouldn't happen after validation)
			// Place them all in a final wave to avoid infinite loop
			waves.push({ waveIndex: waves.length, steps: notReady });
			break;
		}

		// Separate parallel and sequential steps from the ready set
		const parallelSteps: PipelineStep[] = [];
		const sequentialSteps: PipelineStep[] = [];

		for (const step of ready) {
			if (step.parallel) {
				parallelSteps.push(step);
			} else {
				sequentialSteps.push(step);
			}
		}

		// Group all parallel steps into one wave
		if (parallelSteps.length > 0) {
			waves.push({ waveIndex: waves.length, steps: parallelSteps });
			for (const step of parallelSteps) {
				scheduled.add(step.id);
			}
		}

		// Each sequential step gets its own wave
		for (const step of sequentialSteps) {
			waves.push({ waveIndex: waves.length, steps: [step] });
			scheduled.add(step.id);
		}

		remaining.length = 0;
		remaining.push(...notReady);
	}

	return waves;
}

// ============================================================================
// Variable Interpolation
// ============================================================================

/**
 * Replace {variable} patterns in a template string.
 *
 * Supported patterns:
 * - {inputs.varName} — pipeline input value
 * - {stepId.output} — output from a previous step
 * - {previous} — output from the immediately preceding step
 *
 * Unrecognized variables are left unchanged.
 */
export function interpolateVariables(template: string, context: Record<string, string>): string {
	return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
		if (key in context) {
			return context[key];
		}
		return `{${key}}`;
	});
}
