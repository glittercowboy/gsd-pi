import test from "node:test";
import assert from "node:assert/strict";

import { AgentRouter, getDefaultRules } from "../agent-router.js";
import type { RoutingRule } from "../agent-router.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRule(agent: string, when: string, confidence: RoutingRule["confidence"] = "high"): RoutingRule {
	return { agent, when, confidence };
}

// ─── Basic keyword matching ─────────────────────────────────────────────────

test("matches keywords case-insensitively", () => {
	const router = new AgentRouter([makeRule("scout", "explore codebase files")]);
	const results = router.route("Explore the CODEBASE and find files");
	assert.equal(results.length, 1);
	assert.equal(results[0].agent, "scout");
	assert.ok(results[0].score > 0);
});

test("returns empty array when no keywords match", () => {
	const router = new AgentRouter([makeRule("scout", "explore codebase")]);
	const results = router.route("deploy the application to production");
	assert.equal(results.length, 0);
});

test("partial keyword match produces proportional score", () => {
	const router = new AgentRouter([makeRule("scout", "explore codebase files structure")]);
	// only "explore" and "codebase" match (2/4)
	const results = router.route("explore the codebase");
	assert.equal(results.length, 1);
	assert.ok(results[0].score > 0);
	assert.ok(results[0].score < 1.0);
});

// ─── Confidence weighting ───────────────────────────────────────────────────

test("high confidence produces higher score than medium for same match ratio", () => {
	const router = new AgentRouter([
		makeRule("agent-high", "build feature", "high"),
		makeRule("agent-med", "build feature", "medium"),
	]);
	const results = router.route("build a feature");
	assert.equal(results.length, 2);
	assert.equal(results[0].agent, "agent-high");
	assert.ok(results[0].score > results[1].score);
});

test("low confidence weight is 0.4", () => {
	const router = new AgentRouter([makeRule("agent-low", "test", "low")]);
	const results = router.route("test");
	assert.equal(results.length, 1);
	// 1/1 match ratio * 0.4 = 0.4
	assert.equal(results[0].score, 0.4);
});

test("medium confidence weight is 0.7", () => {
	const router = new AgentRouter([makeRule("agent-med", "test", "medium")]);
	const results = router.route("test");
	assert.equal(results[0].score, 0.7);
});

test("high confidence weight is 1.0", () => {
	const router = new AgentRouter([makeRule("agent-high", "test", "high")]);
	const results = router.route("test");
	assert.equal(results[0].score, 1.0);
});

// ─── Sorting ────────────────────────────────────────────────────────────────

test("results are sorted by score descending", () => {
	const router = new AgentRouter([
		makeRule("low-match", "alpha beta gamma delta", "high"),
		makeRule("high-match", "build", "high"),
	]);
	const results = router.route("build alpha");
	assert.equal(results[0].agent, "high-match"); // 1/1 = 1.0
	assert.equal(results[1].agent, "low-match"); // 1/4 = 0.25
});

// ─── addRule / removeRulesForAgent ──────────────────────────────────────────

test("addRule adds a rule", () => {
	const router = new AgentRouter();
	assert.equal(router.getRules().length, 0);
	router.addRule(makeRule("test", "keyword"));
	assert.equal(router.getRules().length, 1);
});

test("removeRulesForAgent removes all rules for that agent", () => {
	const router = new AgentRouter([
		makeRule("keep", "alpha"),
		makeRule("remove", "beta"),
		makeRule("remove", "gamma"),
	]);
	router.removeRulesForAgent("remove");
	assert.equal(router.getRules().length, 1);
	assert.equal(router.getRules()[0].agent, "keep");
});

// ─── bestMatch ──────────────────────────────────────────────────────────────

test("bestMatch returns highest scoring result", () => {
	const router = new AgentRouter([
		makeRule("scout", "explore find files"),
		makeRule("worker", "build create implement"),
	]);
	const best = router.bestMatch("explore and find files in the codebase");
	assert.ok(best);
	assert.equal(best.agent, "scout");
});

test("bestMatch returns undefined when no match", () => {
	const router = new AgentRouter([makeRule("scout", "explore")]);
	const best = router.bestMatch("deploy to production");
	assert.equal(best, undefined);
});

// ─── getRules returns a copy ────────────────────────────────────────────────

test("getRules returns a copy, not the internal array", () => {
	const router = new AgentRouter([makeRule("test", "keyword")]);
	const rules = router.getRules();
	rules.push(makeRule("extra", "extra"));
	assert.equal(router.getRules().length, 1);
});

// ─── Default rules ──────────────────────────────────────────────────────────

test("getDefaultRules returns rules for all built-in agents", () => {
	const rules = getDefaultRules();
	const agents = rules.map((r) => r.agent);
	assert.ok(agents.includes("scout"));
	assert.ok(agents.includes("researcher"));
	assert.ok(agents.includes("worker"));
	assert.ok(agents.includes("javascript-pro"));
	assert.ok(agents.includes("typescript-pro"));
});

test("default rules route typescript task to typescript-pro", () => {
	const router = new AgentRouter(getDefaultRules());
	const best = router.bestMatch("add typescript types and generics to the module");
	assert.ok(best);
	assert.equal(best.agent, "typescript-pro");
});

test("empty when string produces no match", () => {
	const router = new AgentRouter([{ when: "", agent: "ghost", confidence: "high" }]);
	const results = router.route("anything");
	assert.equal(results.length, 0);
});

test("default rules route review task to reviewer", () => {
	const router = new AgentRouter(getDefaultRules());
	const best = router.bestMatch("review this PR for quality issues");
	assert.ok(best);
	assert.equal(best.agent, "reviewer");
});

test("default rules route debug task to debugger", () => {
	const router = new AgentRouter(getDefaultRules());
	const best = router.bestMatch("debug this crash error in the login flow");
	assert.ok(best);
	assert.equal(best.agent, "debugger");
});

test("default rules route planning task to planner", () => {
	const router = new AgentRouter(getDefaultRules());
	const best = router.bestMatch("plan the architecture and breakdown the tasks");
	assert.ok(best);
	assert.equal(best.agent, "planner");
});

test("default rules route documentation task to documenter", () => {
	const router = new AgentRouter(getDefaultRules());
	const best = router.bestMatch("document the API reference for this module");
	assert.ok(best);
	assert.equal(best.agent, "documenter");
});

test("getDefaultRules includes new bundled agents", () => {
	const rules = getDefaultRules();
	const agents = rules.map((r) => r.agent);
	assert.ok(agents.includes("reviewer"));
	assert.ok(agents.includes("debugger"));
	assert.ok(agents.includes("planner"));
	assert.ok(agents.includes("documenter"));
});
