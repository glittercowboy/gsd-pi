import test from "node:test";
import assert from "node:assert/strict";

import { PipelineRunner } from "../pipeline-runtime.js";
import type { PipelineResult } from "../pipeline-runtime.js";
import type { Component, PipelineSpec } from "../component-types.js";
import { ComponentRegistry } from "../component-registry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRegistry(): ComponentRegistry {
	const registry = new ComponentRegistry("/tmp/test");
	// Mark as loaded so it doesn't try to scan real directories
	(registry as any).loaded = true;
	return registry;
}

function makePipelineComponent(spec: PipelineSpec, id = "test-pipeline"): Component {
	return {
		id,
		kind: "pipeline",
		metadata: { name: id, description: "Test pipeline" },
		spec,
		dirPath: "/tmp/test/pipelines/" + id,
		filePath: "/tmp/test/pipelines/" + id + "/component.yaml",
		source: "user",
		format: "component-yaml",
		enabled: true,
	};
}

// ─── Basic execution ─────────────────────────────────────────────────────────

test("run returns pending step results for a simple pipeline", () => {
	const spec: PipelineSpec = {
		steps: [
			{ id: "scan", component: "scanner", task: "scan the code" },
			{ id: "fix", component: "fixer", task: "fix issues", dependsOn: ["scan"] },
		],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.pipelineId, "test-pipeline");
	assert.equal(result.status, "completed");
	assert.equal(result.errors.length, 0);
	assert.ok(result.totalDurationMs >= 0);

	// All steps should be pending (no actual agent invocation)
	for (const wave of result.waves) {
		for (const step of wave.steps) {
			assert.equal(step.status, "pending");
		}
	}
});

test("run applies default input values", () => {
	const spec: PipelineSpec = {
		inputs: {
			target: { type: "string", default: "src/" },
			verbose: { type: "boolean", default: true },
		},
		steps: [
			{ id: "scan", component: "scanner", task: "scan {inputs.target}" },
		],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.status, "completed");
	assert.equal(result.waves[0].steps[0].task, "scan src/");
});

test("run uses provided inputs over defaults", () => {
	const spec: PipelineSpec = {
		inputs: {
			target: { type: "string", default: "src/" },
		},
		steps: [
			{ id: "scan", component: "scanner", task: "scan {inputs.target}" },
		],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec), { target: "lib/" });

	assert.equal(result.waves[0].steps[0].task, "scan lib/");
});

test("run fails if pipeline spec is invalid", () => {
	const spec: PipelineSpec = {
		steps: [],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.status, "failed");
	assert.ok(result.errors.length > 0);
	assert.ok(result.errors[0].includes("at least one step"));
});

test("run interpolates step tasks with context", () => {
	const spec: PipelineSpec = {
		inputs: {
			lang: { type: "string", default: "typescript" },
		},
		steps: [
			{ id: "analyze", component: "analyzer", task: "analyze {inputs.lang} code", output: "report" },
			{ id: "review", component: "reviewer", task: "review {analyze.output} for {inputs.lang}" },
		],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.status, "completed");
	assert.equal(result.waves[0].steps[0].task, "analyze typescript code");
	// The second step should have the interpolated output reference
	const reviewStep = result.waves[1].steps[0];
	assert.ok(reviewStep.task.includes("[output:analyze]"));
	assert.ok(reviewStep.task.includes("typescript"));
});

test("run preserves wave ordering from execution plan", () => {
	const spec: PipelineSpec = {
		steps: [
			{ id: "setup", component: "init", task: "initialize" },
			{ id: "lint", component: "linter", task: "lint", parallel: true, dependsOn: ["setup"] },
			{ id: "test", component: "tester", task: "test", parallel: true, dependsOn: ["setup"] },
			{ id: "deploy", component: "deployer", task: "deploy", dependsOn: ["lint", "test"] },
		],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.status, "completed");
	// Should have 3 waves: setup, lint+test, deploy
	assert.equal(result.waves.length, 3);
	assert.equal(result.waves[0].steps[0].stepId, "setup");
	assert.equal(result.waves[1].steps.length, 2);
	assert.equal(result.waves[2].steps[0].stepId, "deploy");
});

test("run maps pipeline outputs", () => {
	const spec: PipelineSpec = {
		steps: [
			{ id: "scan", component: "scanner", task: "scan code", output: "results" },
		],
		outputs: {
			report: "{scan.output}",
		},
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.status, "completed");
	assert.ok(result.outputs.report);
	assert.ok(result.outputs.report.includes("[output:scan]"));
});

test("run records step duration", () => {
	const spec: PipelineSpec = {
		steps: [
			{ id: "a", component: "agent", task: "do work" },
		],
	};
	const runner = new PipelineRunner(makeRegistry());
	const result = runner.run(makePipelineComponent(spec));

	assert.equal(result.waves[0].steps[0].durationMs !== undefined, true);
	assert.ok(result.waves[0].steps[0].durationMs! >= 0);
});
