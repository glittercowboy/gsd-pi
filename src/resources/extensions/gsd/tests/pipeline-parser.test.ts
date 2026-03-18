import test from "node:test";
import assert from "node:assert/strict";

import {
	validatePipelineSpec,
	buildExecutionPlan,
	interpolateVariables,
} from "../pipeline-parser.js";
import type { PipelineSpec, PipelineStep } from "../component-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<PipelineStep> & { id: string }): PipelineStep {
	return {
		component: overrides.component ?? "test-agent",
		task: overrides.task ?? "do something",
		...overrides,
	};
}

function makeSpec(steps: PipelineStep[], inputs?: PipelineSpec["inputs"]): PipelineSpec {
	return { steps, inputs };
}

// ─── validatePipelineSpec ────────────────────────────────────────────────────

test("validates a correct pipeline spec", () => {
	const spec = makeSpec([
		makeStep({ id: "a" }),
		makeStep({ id: "b", dependsOn: ["a"] }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, true);
	assert.equal(result.errors.length, 0);
});

test("rejects pipeline with no steps", () => {
	const spec = makeSpec([]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors[0].includes("at least one step"));
});

test("detects duplicate step IDs", () => {
	const spec = makeSpec([
		makeStep({ id: "a" }),
		makeStep({ id: "a" }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some(e => e.includes('duplicate step id: "a"')));
});

test("detects missing dependsOn references", () => {
	const spec = makeSpec([
		makeStep({ id: "a", dependsOn: ["nonexistent"] }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some(e => e.includes('depends on unknown step "nonexistent"')));
});

test("detects circular dependencies", () => {
	const spec = makeSpec([
		makeStep({ id: "a", dependsOn: ["b"] }),
		makeStep({ id: "b", dependsOn: ["a"] }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some(e => e.includes("circular dependency")));
});

test("detects self-referencing dependency", () => {
	const spec = makeSpec([
		makeStep({ id: "a", dependsOn: ["a"] }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some(e => e.includes("circular dependency")));
});

test("detects empty component reference", () => {
	const spec = makeSpec([
		makeStep({ id: "a", component: "" }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some(e => e.includes("empty component reference")));
});

test("detects whitespace-only component reference", () => {
	const spec = makeSpec([
		makeStep({ id: "a", component: "   " }),
	]);
	const result = validatePipelineSpec(spec);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some(e => e.includes("empty component reference")));
});

// ─── buildExecutionPlan ──────────────────────────────────────────────────────

test("sequential steps get their own wave each", () => {
	const spec = makeSpec([
		makeStep({ id: "a" }),
		makeStep({ id: "b" }),
		makeStep({ id: "c" }),
	]);
	const waves = buildExecutionPlan(spec);
	assert.equal(waves.length, 3);
	assert.equal(waves[0].steps.length, 1);
	assert.equal(waves[0].steps[0].id, "a");
	assert.equal(waves[1].steps[0].id, "b");
	assert.equal(waves[2].steps[0].id, "c");
});

test("parallel steps without dependencies group into one wave", () => {
	const spec = makeSpec([
		makeStep({ id: "a", parallel: true }),
		makeStep({ id: "b", parallel: true }),
		makeStep({ id: "c", parallel: true }),
	]);
	const waves = buildExecutionPlan(spec);
	assert.equal(waves.length, 1);
	assert.equal(waves[0].steps.length, 3);
});

test("parallel steps with dependencies wait for their wave", () => {
	const spec = makeSpec([
		makeStep({ id: "a" }),
		makeStep({ id: "b", parallel: true, dependsOn: ["a"] }),
		makeStep({ id: "c", parallel: true, dependsOn: ["a"] }),
	]);
	const waves = buildExecutionPlan(spec);
	// Wave 0: a (sequential)
	// Wave 1: b, c (parallel, deps met after wave 0)
	assert.equal(waves.length, 2);
	assert.equal(waves[0].steps[0].id, "a");
	assert.equal(waves[1].steps.length, 2);
	const wave1Ids = waves[1].steps.map(s => s.id).sort();
	assert.deepStrictEqual(wave1Ids, ["b", "c"]);
});

test("mixed parallel and sequential ordering", () => {
	const spec = makeSpec([
		makeStep({ id: "setup" }),
		makeStep({ id: "lint", parallel: true, dependsOn: ["setup"] }),
		makeStep({ id: "test", parallel: true, dependsOn: ["setup"] }),
		makeStep({ id: "deploy", dependsOn: ["lint", "test"] }),
	]);
	const waves = buildExecutionPlan(spec);
	// Wave 0: setup (sequential)
	// Wave 1: lint + test (parallel, deps on setup met)
	// Wave 2: deploy (sequential, deps on lint+test met)
	assert.equal(waves.length, 3);
	assert.equal(waves[0].steps[0].id, "setup");
	assert.equal(waves[1].steps.length, 2);
	assert.equal(waves[2].steps[0].id, "deploy");
});

test("wave indices are sequential starting from 0", () => {
	const spec = makeSpec([
		makeStep({ id: "a" }),
		makeStep({ id: "b", parallel: true }),
		makeStep({ id: "c", parallel: true }),
		makeStep({ id: "d", dependsOn: ["b", "c"] }),
	]);
	const waves = buildExecutionPlan(spec);
	for (let i = 0; i < waves.length; i++) {
		assert.equal(waves[i].waveIndex, i);
	}
});

// ─── interpolateVariables ────────────────────────────────────────────────────

test("replaces simple variables", () => {
	const result = interpolateVariables("hello {name}", { name: "world" });
	assert.equal(result, "hello world");
});

test("replaces inputs.varName patterns", () => {
	const result = interpolateVariables(
		"analyze {inputs.target} with {inputs.mode}",
		{ "inputs.target": "src/", "inputs.mode": "strict" },
	);
	assert.equal(result, "analyze src/ with strict");
});

test("replaces stepId.output patterns", () => {
	const result = interpolateVariables(
		"use results from {scan.output}",
		{ "scan.output": "found 5 issues" },
	);
	assert.equal(result, "use results from found 5 issues");
});

test("replaces {previous} pattern", () => {
	const result = interpolateVariables(
		"continue with {previous}",
		{ previous: "step-1 output" },
	);
	assert.equal(result, "continue with step-1 output");
});

test("leaves unrecognized variables unchanged", () => {
	const result = interpolateVariables("hello {unknown} world", {});
	assert.equal(result, "hello {unknown} world");
});

test("handles multiple replacements in one string", () => {
	const result = interpolateVariables(
		"{a} and {b} and {c}",
		{ a: "1", b: "2", c: "3" },
	);
	assert.equal(result, "1 and 2 and 3");
});

test("handles template with no variables", () => {
	const result = interpolateVariables("no variables here", { foo: "bar" });
	assert.equal(result, "no variables here");
});
