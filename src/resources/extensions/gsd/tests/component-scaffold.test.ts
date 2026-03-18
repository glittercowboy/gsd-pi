/**
 * Component Scaffold Templates — Unit Tests
 *
 * Tests for template-based scaffolding of skills and agents.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	getSkillTemplateContent,
	getAgentTemplateContent,
	listSkillTemplates,
	listAgentTemplates,
} from "../component-scaffold.js";
import type { SkillTemplate, AgentTemplate } from "../component-scaffold.js";

// ============================================================================
// Skill Templates
// ============================================================================

test("getSkillTemplateContent — language template replaces placeholders", () => {
	const content = getSkillTemplateContent("language", {
		name: "typescript",
		description: "TypeScript coding patterns",
	});

	assert.ok(content.includes("typescript"));
	assert.ok(content.includes("TypeScript coding patterns"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getSkillTemplateContent — framework template replaces placeholders", () => {
	const content = getSkillTemplateContent("framework", {
		name: "react-patterns",
		description: "React framework patterns",
	});

	assert.ok(content.includes("react-patterns"));
	assert.ok(content.includes("React framework patterns"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getSkillTemplateContent — review template replaces placeholders", () => {
	const content = getSkillTemplateContent("review", {
		name: "code-review",
		description: "Comprehensive code review",
	});

	assert.ok(content.includes("code-review"));
	assert.ok(content.includes("Comprehensive code review"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getSkillTemplateContent — security template replaces placeholders", () => {
	const content = getSkillTemplateContent("security", {
		name: "owasp-scanner",
		description: "OWASP vulnerability scanning",
	});

	assert.ok(content.includes("owasp-scanner"));
	assert.ok(content.includes("OWASP vulnerability scanning"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getSkillTemplateContent — blank template returns basic content", () => {
	const content = getSkillTemplateContent("blank", {
		name: "my-skill",
		description: "A custom skill",
	});

	assert.ok(content.includes("a custom skill"));
	assert.ok(content.includes("## Role"));
	assert.ok(content.includes("## Key Rules"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getSkillTemplateContent — language template includes expected sections", () => {
	const content = getSkillTemplateContent("language", {
		name: "go-lang",
		description: "Go language patterns",
	});

	assert.ok(content.includes("## Role"));
	assert.ok(content.includes("## Language Conventions"));
	assert.ok(content.includes("## Key Patterns"));
	assert.ok(content.includes("## Common Mistakes"));
	assert.ok(content.includes("## Code Style Rules"));
});

test("getSkillTemplateContent — framework template includes expected sections", () => {
	const content = getSkillTemplateContent("framework", {
		name: "nextjs",
		description: "Next.js patterns",
	});

	assert.ok(content.includes("## Role"));
	assert.ok(content.includes("## Framework Conventions"));
	assert.ok(content.includes("## State Management"));
	assert.ok(content.includes("## Testing Approach"));
	assert.ok(content.includes("## Common Pitfalls"));
});

test("getSkillTemplateContent — review template includes severity levels", () => {
	const content = getSkillTemplateContent("review", {
		name: "pr-review",
		description: "Pull request review",
	});

	assert.ok(content.includes("Critical"));
	assert.ok(content.includes("Major"));
	assert.ok(content.includes("Minor"));
	assert.ok(content.includes("## Verdict Criteria"));
});

test("getSkillTemplateContent — security template includes OWASP", () => {
	const content = getSkillTemplateContent("security", {
		name: "sec-audit",
		description: "Security audit",
	});

	assert.ok(content.includes("OWASP"));
	assert.ok(content.includes("CVE"));
	assert.ok(content.includes("## Severity Classification"));
});

// ============================================================================
// Agent Templates
// ============================================================================

test("getAgentTemplateContent — specialist template replaces placeholders", () => {
	const content = getAgentTemplateContent("specialist", {
		name: "db-expert",
		description: "Database optimization",
	});

	assert.ok(content.includes("db-expert"));
	assert.ok(content.includes("Database optimization"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getAgentTemplateContent — reviewer template replaces placeholders", () => {
	const content = getAgentTemplateContent("reviewer", {
		name: "code-checker",
		description: "Automated code checking",
	});

	assert.ok(content.includes("code-checker"));
	assert.ok(content.includes("Automated code checking"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getAgentTemplateContent — researcher template replaces placeholders", () => {
	const content = getAgentTemplateContent("researcher", {
		name: "doc-finder",
		description: "Documentation research",
	});

	assert.ok(content.includes("doc-finder"));
	assert.ok(content.includes("Documentation research"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getAgentTemplateContent — blank template returns basic content", () => {
	const content = getAgentTemplateContent("blank", {
		name: "my-agent",
		description: "A custom agent",
	});

	assert.ok(content.includes("my-agent"));
	assert.ok(content.includes("a custom agent"));
	assert.ok(content.includes("## Role"));
	assert.ok(content.includes("## Strategy"));
	assert.ok(!content.includes("{{name}}"));
	assert.ok(!content.includes("{{description}}"));
});

test("getAgentTemplateContent — specialist includes strategy steps", () => {
	const content = getAgentTemplateContent("specialist", {
		name: "test-agent",
		description: "Test",
	});

	assert.ok(content.includes("Understand"));
	assert.ok(content.includes("Plan"));
	assert.ok(content.includes("Execute"));
	assert.ok(content.includes("Report"));
});

test("getAgentTemplateContent — reviewer includes finding format", () => {
	const content = getAgentTemplateContent("reviewer", {
		name: "test-agent",
		description: "Test",
	});

	assert.ok(content.includes("## Finding Format"));
	assert.ok(content.includes("## Verdict Criteria"));
	assert.ok(content.includes("Severity"));
});

test("getAgentTemplateContent — researcher includes citation format", () => {
	const content = getAgentTemplateContent("researcher", {
		name: "test-agent",
		description: "Test",
	});

	assert.ok(content.includes("## Citation Format"));
	assert.ok(content.includes("## Sources"));
	assert.ok(content.includes("## Confidence"));
});

// ============================================================================
// List Functions
// ============================================================================

test("listSkillTemplates returns all 5 templates", () => {
	const templates = listSkillTemplates();
	assert.strictEqual(templates.length, 5);

	const names = templates.map((t) => t.name);
	assert.ok(names.includes("language"));
	assert.ok(names.includes("framework"));
	assert.ok(names.includes("review"));
	assert.ok(names.includes("security"));
	assert.ok(names.includes("blank"));
});

test("listSkillTemplates returns descriptions for all entries", () => {
	const templates = listSkillTemplates();
	for (const t of templates) {
		assert.ok(typeof t.description === "string");
		assert.ok(t.description.length > 0, `Template "${t.name}" has empty description`);
	}
});

test("listAgentTemplates returns all 4 templates", () => {
	const templates = listAgentTemplates();
	assert.strictEqual(templates.length, 4);

	const names = templates.map((t) => t.name);
	assert.ok(names.includes("specialist"));
	assert.ok(names.includes("reviewer"));
	assert.ok(names.includes("researcher"));
	assert.ok(names.includes("blank"));
});

test("listAgentTemplates returns descriptions for all entries", () => {
	const templates = listAgentTemplates();
	for (const t of templates) {
		assert.ok(typeof t.description === "string");
		assert.ok(t.description.length > 0, `Template "${t.name}" has empty description`);
	}
});

// ============================================================================
// Placeholder Safety
// ============================================================================

test("no skill template leaves unreplaced placeholders", () => {
	const allSkillTemplates: SkillTemplate[] = ["language", "framework", "review", "security", "blank"];
	for (const template of allSkillTemplates) {
		const content = getSkillTemplateContent(template, {
			name: "test-skill",
			description: "Test description",
		});
		assert.ok(!content.includes("{{name}}"), `${template} template has unreplaced {{name}}`);
		assert.ok(!content.includes("{{description}}"), `${template} template has unreplaced {{description}}`);
	}
});

test("no agent template leaves unreplaced placeholders", () => {
	const allAgentTemplates: AgentTemplate[] = ["specialist", "reviewer", "researcher", "blank"];
	for (const template of allAgentTemplates) {
		const content = getAgentTemplateContent(template, {
			name: "test-agent",
			description: "Test description",
		});
		assert.ok(!content.includes("{{name}}"), `${template} template has unreplaced {{name}}`);
		assert.ok(!content.includes("{{description}}"), `${template} template has unreplaced {{description}}`);
	}
});
