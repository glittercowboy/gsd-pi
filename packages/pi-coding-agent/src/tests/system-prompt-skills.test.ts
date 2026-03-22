/**
 * System prompt skill-catalog gating tests.
 *
 * Verifies that <available_skills> is included based on the presence of the
 * Skill built-in tool, not the read tool.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../core/system-prompt.js";
import type { Skill } from "../core/skills.js";

const sampleSkill: Skill = {
	name: "swift-testing",
	description: "Use for Swift Testing assertions and verification patterns.",
	filePath: "/project/.pi/skills/swift-testing/SKILL.md",
	baseDir: "/project/.pi/skills/swift-testing",
	source: "project",
	disableModelInvocation: false,
};

const hiddenSkill: Skill = {
	name: "hidden-skill",
	description: "Use only via explicit /skill:hidden-skill.",
	filePath: "/project/.pi/skills/hidden-skill/SKILL.md",
	baseDir: "/project/.pi/skills/hidden-skill",
	source: "project",
	disableModelInvocation: true,
};

// ─── Default prompt path ────────────────────────────────────────────────────

test("default prompt: includes skill catalog when Skill tool is present without read", () => {
	const prompt = buildSystemPrompt({
		selectedTools: ["bash", "edit", "write", "Skill"],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(prompt.includes("<available_skills>"), "should contain <available_skills>");
	assert.ok(prompt.includes("swift-testing"), "should contain the skill name");
});

test("default prompt: includes skill catalog when no selectedTools (defaults)", () => {
	const prompt = buildSystemPrompt({
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(prompt.includes("<available_skills>"), "defaults should include catalog");
});

test("default prompt: excludes skill catalog when read is present without Skill", () => {
	const prompt = buildSystemPrompt({
		selectedTools: ["read", "bash", "edit", "write"],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "read without Skill should exclude catalog");
});

test("default prompt: excludes skill catalog when neither Skill nor read is present", () => {
	const prompt = buildSystemPrompt({
		selectedTools: ["bash", "edit", "write"],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "should not contain <available_skills>");
});

test("default prompt: excludes skill catalog when Skill present but no skills loaded", () => {
	const prompt = buildSystemPrompt({
		selectedTools: ["bash", "edit", "write", "Skill"],
		skills: [],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "empty skills list should produce no catalog");
});

test("default prompt: excludes skill catalog when selectedTools is empty array", () => {
	const prompt = buildSystemPrompt({
		selectedTools: [],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "empty selectedTools array should exclude catalog");
});

test("default prompt: excludes hidden skills from the skill catalog", () => {
	const prompt = buildSystemPrompt({
		selectedTools: ["bash", "Skill"],
		skills: [sampleSkill, hiddenSkill],
		cwd: "/project",
	});
	assert.ok(prompt.includes("swift-testing"), "visible skill should be listed");
	assert.ok(!prompt.includes("hidden-skill"), "hidden skill should not be listed");
});

// ─── Custom prompt path ────────────────────────────────────────────────────

test("custom prompt: includes skill catalog when Skill tool is present without read", () => {
	const prompt = buildSystemPrompt({
		customPrompt: "You are a helpful assistant.",
		selectedTools: ["bash", "Skill"],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(prompt.includes("<available_skills>"), "should contain <available_skills>");
	assert.ok(prompt.includes("swift-testing"), "should contain the skill name");
});

test("custom prompt: includes skill catalog when selectedTools is unset", () => {
	const prompt = buildSystemPrompt({
		customPrompt: "You are a helpful assistant.",
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(prompt.includes("<available_skills>"), "defaults should include catalog");
});

test("custom prompt: excludes skill catalog when Skill is not in selectedTools", () => {
	const prompt = buildSystemPrompt({
		customPrompt: "You are a helpful assistant.",
		selectedTools: ["bash", "edit"],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "should not contain <available_skills>");
});

test("custom prompt: excludes skill catalog when read is present without Skill", () => {
	const prompt = buildSystemPrompt({
		customPrompt: "You are a helpful assistant.",
		selectedTools: ["read", "bash"],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "read without Skill should exclude catalog");
});

test("custom prompt: excludes skill catalog when selectedTools is empty array", () => {
	const prompt = buildSystemPrompt({
		customPrompt: "You are a helpful assistant.",
		selectedTools: [],
		skills: [sampleSkill],
		cwd: "/project",
	});
	assert.ok(!prompt.includes("<available_skills>"), "empty selectedTools array should exclude catalog");
});
