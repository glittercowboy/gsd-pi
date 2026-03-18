/**
 * Component Scaffold Templates
 *
 * Provides template-based scaffolding for creating new skills and agents.
 * Reads template files from scaffold-templates/ and replaces placeholders.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Types
// ============================================================================

export type SkillTemplate = 'language' | 'framework' | 'review' | 'security' | 'blank';
export type AgentTemplate = 'specialist' | 'reviewer' | 'researcher' | 'blank';

export interface TemplateVars {
	name: string;
	description: string;
}

interface TemplateInfo<T extends string> {
	name: T;
	description: string;
}

// ============================================================================
// Constants
// ============================================================================

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const TEMPLATES_DIR = join(__dirname_local, 'scaffold-templates');

const SKILL_TEMPLATE_DESCRIPTIONS: Record<SkillTemplate, string> = {
	language: 'Language-specific coding conventions and patterns',
	framework: 'Framework architecture, routing, and state management patterns',
	review: 'Structured code review with severity levels and verdicts',
	security: 'Security analysis with OWASP coverage and CVE references',
	blank: 'Minimal starting template with basic sections',
};

const AGENT_TEMPLATE_DESCRIPTIONS: Record<AgentTemplate, string> = {
	specialist: 'Domain specialist with a 4-step strategy approach',
	reviewer: 'Review-focused agent with structured finding format',
	researcher: 'Research agent with source citations and confidence levels',
	blank: 'Minimal starting template with basic sections',
};

// ============================================================================
// Blank Templates (inline, matching component-commands.ts)
// ============================================================================

function buildBlankSkillTemplate(name: string, description: string): string {
	return `You are a specialized assistant for ${description.toLowerCase()}.

## Role

Describe what this skill does and when it should be used.

## Key Rules

1. Rule one
2. Rule two
3. Rule three

## Patterns & Examples

Provide examples of the patterns this skill teaches.

## Common Mistakes

List common mistakes to avoid.
`;
}

function buildBlankAgentTemplate(name: string, description: string): string {
	return `You are ${name}, a specialized agent for ${description.toLowerCase()}.

## Role

Describe this agent's purpose and specialization.

## Strategy

1. First, understand the task
2. Then, plan your approach
3. Execute methodically
4. Report findings clearly

## Output Format

## Completed

What was done.

## Files Changed

- \`path/to/file.ts\` - what changed

## Notes

Anything the caller should know.
`;
}

// ============================================================================
// Template Loading
// ============================================================================

function loadTemplate(filename: string): string {
	return readFileSync(join(TEMPLATES_DIR, filename), 'utf-8');
}

function applyVars(content: string, vars: TemplateVars): string {
	return content
		.replace(/\{\{name\}\}/g, vars.name)
		.replace(/\{\{description\}\}/g, vars.description);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get rendered skill template content with placeholders replaced.
 */
export function getSkillTemplateContent(template: SkillTemplate, vars: TemplateVars): string {
	if (template === 'blank') {
		return buildBlankSkillTemplate(vars.name, vars.description);
	}

	const filename = `skill-${template}.md`;
	const raw = loadTemplate(filename);
	return applyVars(raw, vars);
}

/**
 * Get rendered agent template content with placeholders replaced.
 */
export function getAgentTemplateContent(template: AgentTemplate, vars: TemplateVars): string {
	if (template === 'blank') {
		return buildBlankAgentTemplate(vars.name, vars.description);
	}

	const filename = `agent-${template}.md`;
	const raw = loadTemplate(filename);
	return applyVars(raw, vars);
}

/**
 * List all available skill templates with descriptions.
 */
export function listSkillTemplates(): Array<TemplateInfo<SkillTemplate>> {
	return (Object.keys(SKILL_TEMPLATE_DESCRIPTIONS) as SkillTemplate[]).map((name) => ({
		name,
		description: SKILL_TEMPLATE_DESCRIPTIONS[name],
	}));
}

/**
 * List all available agent templates with descriptions.
 */
export function listAgentTemplates(): Array<TemplateInfo<AgentTemplate>> {
	return (Object.keys(AGENT_TEMPLATE_DESCRIPTIONS) as AgentTemplate[]).map((name) => ({
		name,
		description: AGENT_TEMPLATE_DESCRIPTIONS[name],
	}));
}
