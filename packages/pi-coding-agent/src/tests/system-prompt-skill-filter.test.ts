// @gsd/pi-coding-agent + system-prompt-skill-filter.test — coverage for the
// optional `skillFilter` option added to buildSystemPrompt (RFC #4779). The
// filter lets consumers narrow the <available_skills> catalog rendered into
// the cached system prompt without touching skill loading or invocation.

import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../core/system-prompt.js";
import type { Skill } from "../core/skills.js";

function makeSkill(name: string, description = `description for ${name}`): Skill {
	return {
		name,
		description,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "project",
		disableModelInvocation: false,
	};
}

function extractAvailableSkills(prompt: string): string {
	const start = prompt.indexOf("<available_skills>");
	const end = prompt.indexOf("</available_skills>");
	if (start === -1 || end === -1) return "";
	return prompt.slice(start, end + "</available_skills>".length);
}

// ─── Default branch (no customPrompt) ──────────────────────────────────────

test("buildSystemPrompt: skillFilter omits filtered-out skills from <available_skills>", () => {
	const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma")];
	const prompt = buildSystemPrompt({
		skills,
		selectedTools: ["read", "Skill"],
		skillFilter: skill => skill.name !== "beta",
	});

	const section = extractAvailableSkills(prompt);
	assert.ok(section.length > 0, "catalog section should render");
	assert.match(section, /<name>alpha<\/name>/);
	assert.match(section, /<name>gamma<\/name>/);
	assert.doesNotMatch(section, /<name>beta<\/name>/);
});

test("buildSystemPrompt: skillFilter omitted preserves pre-filter behavior (all skills render)", () => {
	const skills = [makeSkill("alpha"), makeSkill("beta")];
	const prompt = buildSystemPrompt({
		skills,
		selectedTools: ["read", "Skill"],
	});

	const section = extractAvailableSkills(prompt);
	assert.match(section, /<name>alpha<\/name>/);
	assert.match(section, /<name>beta<\/name>/);
});

test("buildSystemPrompt: skillFilter that rejects every skill suppresses the <available_skills> block", () => {
	const skills = [makeSkill("alpha"), makeSkill("beta")];
	const prompt = buildSystemPrompt({
		skills,
		selectedTools: ["read", "Skill"],
		skillFilter: () => false,
	});

	// With zero visible skills, formatSkillsForPrompt returns an empty string,
	// so the opening tag should not appear anywhere.
	assert.ok(!prompt.includes("<available_skills>"));
});

// ─── Custom-prompt branch ──────────────────────────────────────────────────

test("buildSystemPrompt (customPrompt): skillFilter applies to the catalog appended onto a custom prompt", () => {
	const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma")];
	const prompt = buildSystemPrompt({
		customPrompt: "CUSTOM BASE",
		skills,
		selectedTools: ["read", "Skill"],
		skillFilter: skill => skill.name === "alpha",
	});

	const section = extractAvailableSkills(prompt);
	assert.match(section, /<name>alpha<\/name>/);
	assert.doesNotMatch(section, /<name>beta<\/name>/);
	assert.doesNotMatch(section, /<name>gamma<\/name>/);
});

// ─── Interaction with disableModelInvocation ──────────────────────────────

test("buildSystemPrompt: skillFilter composes with disableModelInvocation (both must pass)", () => {
	// A skill already hidden from the catalog by disableModelInvocation must
	// remain hidden even if skillFilter would otherwise admit it. The filter
	// narrows, it does not override the existing invisibility contract.
	const skills: Skill[] = [
		{ ...makeSkill("visible"), disableModelInvocation: false },
		{ ...makeSkill("hidden"), disableModelInvocation: true },
	];
	const prompt = buildSystemPrompt({
		skills,
		selectedTools: ["read", "Skill"],
		skillFilter: () => true,
	});

	const section = extractAvailableSkills(prompt);
	assert.match(section, /<name>visible<\/name>/);
	assert.doesNotMatch(section, /<name>hidden<\/name>/);
});

// ─── Pass-through of non-filtered fields ──────────────────────────────────

test("buildSystemPrompt: skillFilter does not affect context files or cwd rendering", () => {
	const skills = [makeSkill("alpha")];
	const prompt = buildSystemPrompt({
		skills,
		cwd: "/tmp/example",
		contextFiles: [{ path: "CLAUDE.md", content: "project instructions" }],
		selectedTools: ["read", "Skill"],
		skillFilter: () => false,
	});

	assert.ok(prompt.includes("/tmp/example"), "cwd should still render");
	assert.ok(prompt.includes("project instructions"), "context files should still render");
	assert.ok(!prompt.includes("<available_skills>"), "no skill catalog when filter rejects all");
});

// ─── Exception safety ─────────────────────────────────────────────────────

test("buildSystemPrompt: skillFilter that throws falls back to unfiltered list and does not propagate", (t) => {
	// A buggy consumer predicate must not bubble out of buildSystemPrompt.
	// If it did, _rebuildSystemPrompt could unwind mid-setTools() and leave
	// the session with updated tools but a stale system prompt.
	const skills = [makeSkill("alpha"), makeSkill("beta")];

	// Suppress the console.warn the fallback emits so test output stays clean.
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
	t.after(() => { console.warn = originalWarn; });

	let prompt = "";
	assert.doesNotThrow(() => {
		prompt = buildSystemPrompt({
			skills,
			selectedTools: ["read", "Skill"],
			skillFilter: () => { throw new Error("consumer bug"); },
		});
	});

	const section = extractAvailableSkills(prompt);
	assert.match(section, /<name>alpha<\/name>/, "alpha should render (fallback to unfiltered)");
	assert.match(section, /<name>beta<\/name>/, "beta should render (fallback to unfiltered)");
	assert.ok(
		warnings.some(w => w.includes("skillFilter threw") && w.includes("consumer bug")),
		"fallback should emit an identifying warning",
	);
});
