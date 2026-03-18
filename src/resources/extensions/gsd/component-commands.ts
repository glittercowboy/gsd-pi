/**
 * Component System CLI Commands
 *
 * Handlers for `/gsd skill`, `/gsd agent`, and `/gsd components` commands.
 * Delegates to ComponentRegistry for discovery and ComponentLoader for I/O.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getAgentDir } from '@gsd/pi-coding-agent';

const CONFIG_DIR_NAME = '.gsd';
import type { ExtensionAPI, ExtensionCommandContext } from '@gsd/pi-coding-agent';
import { getComponentRegistry, resetComponentRegistry } from './component-registry.js';
import type { Component, ComponentKind, PipelineSpec } from './component-types.js';
import { validatePipelineSpec, buildExecutionPlan } from './pipeline-parser.js';

// ============================================================================
// Command Router
// ============================================================================

/**
 * Handle `/gsd skill <subcommand>` commands.
 */
export async function handleSkillCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const subcommand = parts[0] || 'list';
	const rest = parts.slice(1).join(' ');

	switch (subcommand) {
		case 'list':
			return handleList(ctx, pi, 'skill', rest);
		case 'info':
			return handleInfo(ctx, pi, rest, 'skill');
		case 'new':
			return handleNew(ctx, pi, 'skill', rest);
		case 'remove':
			return handleRemove(ctx, pi, rest, 'skill');
		default:
			return sendComponentMessage(pi, `Unknown skill subcommand: ${subcommand}. Available: list, info, new, remove`);
	}
}

/**
 * Handle `/gsd agent <subcommand>` commands.
 */
export async function handleAgentCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const subcommand = parts[0] || 'list';
	const rest = parts.slice(1).join(' ');

	switch (subcommand) {
		case 'list':
			return handleList(ctx, pi, 'agent', rest);
		case 'info':
			return handleInfo(ctx, pi, rest, 'agent');
		case 'new':
			return handleNew(ctx, pi, 'agent', rest);
		case 'remove':
			return handleRemove(ctx, pi, rest, 'agent');
		default:
			return sendComponentMessage(pi, `Unknown agent subcommand: ${subcommand}. Available: list, info, new, remove`);
	}
}

/**
 * Handle `/gsd components <subcommand>` commands.
 */
export async function handleComponentsCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const subcommand = parts[0] || 'list';
	const rest = parts.slice(1).join(' ');

	switch (subcommand) {
		case 'list':
			return handleList(ctx, pi, undefined, rest);
		case 'info':
			return handleInfo(ctx, pi, rest);
		case 'validate':
			return handleValidate(ctx, pi, rest);
		default:
			return sendComponentMessage(pi, `Unknown components subcommand: ${subcommand}. Available: list, info, validate`);
	}
}

/**
 * Handle `/gsd pipeline <subcommand>` commands.
 */
export async function handlePipelineCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const subcommand = parts[0] || 'list';
	const rest = parts.slice(1).join(' ');

	switch (subcommand) {
		case 'list':
			return handleList(ctx, pi, 'pipeline', rest);
		case 'info':
			return handlePipelineInfo(ctx, pi, rest);
		case 'run':
			return handlePipelineRun(ctx, pi, rest);
		case 'validate':
			return handlePipelineValidate(ctx, pi, rest);
		default:
			return sendComponentMessage(pi, `Unknown pipeline subcommand: ${subcommand}. Available: list, info, run, validate`);
	}
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

async function handleList(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	kind?: ComponentKind,
	args?: string,
): Promise<void> {
	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	// Parse flags
	const scopeFilter = args?.includes('--scope=project') ? 'project'
		: args?.includes('--scope=user') ? 'user'
			: undefined;

	const components = registry.list({
		kind: kind ? kind : undefined,
		source: scopeFilter ? scopeFilter as any : undefined,
	});

	if (components.length === 0) {
		const label = kind || 'component';
		return sendComponentMessage(pi, `No ${label}s found.`);
	}

	// Group by kind
	const grouped = new Map<string, Component[]>();
	for (const c of components) {
		const group = grouped.get(c.kind) ?? [];
		group.push(c);
		grouped.set(c.kind, group);
	}

	const lines: string[] = [];

	for (const [groupKind, items] of grouped) {
		lines.push(`## ${capitalize(groupKind)}s (${items.length})`);
		lines.push('');

		for (const c of items.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
			const scope = c.source === 'project' ? '(project)' : c.source === 'builtin' ? '(builtin)' : '(user)';
			const format = c.format === 'component-yaml' ? '' : ` [${c.format}]`;
			const tags = c.metadata.tags?.length ? ` [${c.metadata.tags.join(', ')}]` : '';
			const version = c.metadata.version ? ` v${c.metadata.version}` : '';
			lines.push(`- **${c.id}**${version} ${scope}${format}${tags}`);
			lines.push(`  ${c.metadata.description}`);
		}
		lines.push('');
	}

	const diagnostics = registry.getDiagnostics();
	if (diagnostics.length > 0) {
		lines.push(`---`);
		lines.push(`${diagnostics.length} diagnostic(s) found. Run \`/gsd components validate\` for details.`);
	}

	return sendComponentMessage(pi, lines.join('\n'));
}

async function handleInfo(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	name: string,
	kind?: ComponentKind,
): Promise<void> {
	if (!name.trim()) {
		return sendComponentMessage(pi, `Usage: /gsd ${kind || 'components'} info <name>`);
	}

	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	const component = registry.resolve(name.trim());
	if (!component) {
		return sendComponentMessage(pi, `Component "${name.trim()}" not found.`);
	}

	if (kind && component.kind !== kind) {
		return sendComponentMessage(pi, `"${name.trim()}" is a ${component.kind}, not a ${kind}.`);
	}

	const lines: string[] = [
		`## ${component.metadata.name}`,
		'',
		`| Field | Value |`,
		`|-------|-------|`,
		`| **ID** | ${component.id} |`,
		`| **Kind** | ${component.kind} |`,
		`| **Description** | ${component.metadata.description} |`,
		`| **Source** | ${component.source} |`,
		`| **Format** | ${component.format} |`,
		`| **Directory** | ${component.dirPath} |`,
		`| **Definition** | ${component.filePath} |`,
		`| **Enabled** | ${component.enabled ? 'Yes' : 'No'} |`,
	];

	if (component.metadata.version) {
		lines.push(`| **Version** | ${component.metadata.version} |`);
	}
	if (component.metadata.author) {
		lines.push(`| **Author** | ${component.metadata.author.name} |`);
	}
	if (component.metadata.tags?.length) {
		lines.push(`| **Tags** | ${component.metadata.tags.join(', ')} |`);
	}
	if (component.metadata.namespace) {
		lines.push(`| **Namespace** | ${component.metadata.namespace} |`);
	}

	// Kind-specific details
	if (component.kind === 'agent') {
		const spec = component.spec as any;
		if (spec.model) lines.push(`| **Model** | ${spec.model} |`);
		if (spec.tools) {
			const tools = Array.isArray(spec.tools) ? spec.tools : spec.tools.allow;
			if (tools) lines.push(`| **Tools** | ${tools.join(', ')} |`);
		}
		if (spec.maxTurns) lines.push(`| **Max Turns** | ${spec.maxTurns} |`);
		if (spec.timeoutMinutes) lines.push(`| **Timeout** | ${spec.timeoutMinutes}m |`);
		if (spec.extends) lines.push(`| **Extends** | ${spec.extends} |`);
	}

	if (component.requires) {
		lines.push('');
		lines.push('### Dependencies');
		if (component.requires.skills?.length) {
			lines.push(`- Skills: ${component.requires.skills.join(', ')}`);
		}
		if (component.requires.agents?.length) {
			lines.push(`- Agents: ${component.requires.agents.join(', ')}`);
		}
		if (component.requires.mcpServers?.length) {
			lines.push(`- MCP Servers: ${component.requires.mcpServers.join(', ')}`);
		}
	}

	return sendComponentMessage(pi, lines.join('\n'));
}

async function handleNew(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	kind: ComponentKind,
	args: string,
): Promise<void> {
	// Extract name from args or prompt the AI to ask
	const name = args.trim();

	if (!name) {
		const prompt = kind === 'skill'
			? `The user wants to create a new skill. Ask them for:\n1. Skill name (lowercase, hyphens allowed)\n2. Short description\n3. Scope (project or global)\n4. Tags (optional)\n\nThen create the skill using the component system.`
			: `The user wants to create a new agent. Ask them for:\n1. Agent name (lowercase, hyphens allowed)\n2. Short description\n3. Model preference (default: use session model)\n4. Allowed tools (multi-select: bash, read, write, edit, grep, glob, web-search, browser)\n5. Scope (project or global)\n\nThen create the agent using the component system.`;

		return sendComponentMessage(pi, prompt, true);
	}

	// If name provided, create with defaults
	return createComponent(ctx, pi, kind, name);
}

async function handleRemove(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	name: string,
	kind?: ComponentKind,
): Promise<void> {
	if (!name.trim()) {
		return sendComponentMessage(pi, `Usage: /gsd ${kind || 'components'} remove <name>`);
	}

	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	const component = registry.resolve(name.trim());
	if (!component) {
		return sendComponentMessage(pi, `Component "${name.trim()}" not found.`);
	}

	if (kind && component.kind !== kind) {
		return sendComponentMessage(pi, `"${name.trim()}" is a ${component.kind}, not a ${kind}.`);
	}

	if (component.source === 'builtin') {
		return sendComponentMessage(pi, `Cannot remove builtin component "${component.id}".`);
	}

	// Don't actually delete files from commands — ask the AI to confirm
	return sendComponentMessage(
		pi,
		`Found ${component.kind} "${component.id}" at ${component.dirPath} (${component.source}).\n\n` +
		`To remove it, delete the directory: \`${component.dirPath}\`\n\n` +
		`Confirm you want to delete this ${component.kind}?`,
		true,
	);
}

async function handleValidate(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	args: string,
): Promise<void> {
	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	const diagnostics = registry.getDiagnostics();
	const components = registry.list();

	const lines: string[] = [
		`## Component Validation Report`,
		'',
		`**Total components**: ${components.length}`,
		`**Skills**: ${components.filter(c => c.kind === 'skill').length}`,
		`**Agents**: ${components.filter(c => c.kind === 'agent').length}`,
		`**Pipelines**: ${components.filter(c => c.kind === 'pipeline').length}`,
		'',
	];

	if (diagnostics.length === 0) {
		lines.push('No issues found.');
	} else {
		lines.push(`### Issues (${diagnostics.length})`);
		lines.push('');
		for (const d of diagnostics) {
			const icon = d.type === 'error' ? 'ERROR' : d.type === 'collision' ? 'COLLISION' : 'WARN';
			lines.push(`- **${icon}**: ${d.message}${d.path ? ` (${d.path})` : ''}`);
		}
	}

	// Format breakdown
	const formats = {
		'component-yaml': components.filter(c => c.format === 'component-yaml').length,
		'skill-md': components.filter(c => c.format === 'skill-md').length,
		'agent-md': components.filter(c => c.format === 'agent-md').length,
	};

	lines.push('');
	lines.push('### Format Distribution');
	lines.push(`- component.yaml (new): ${formats['component-yaml']}`);
	lines.push(`- SKILL.md (legacy): ${formats['skill-md']}`);
	lines.push(`- Agent .md (legacy): ${formats['agent-md']}`);

	return sendComponentMessage(pi, lines.join('\n'));
}

// ============================================================================
// Pipeline-specific Handlers
// ============================================================================

async function handlePipelineInfo(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	name: string,
): Promise<void> {
	if (!name.trim()) {
		return sendComponentMessage(pi, 'Usage: /gsd pipeline info <name>');
	}

	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	const component = registry.resolve(name.trim());
	if (!component) {
		return sendComponentMessage(pi, `Pipeline "${name.trim()}" not found.`);
	}

	if (component.kind !== 'pipeline') {
		return sendComponentMessage(pi, `"${name.trim()}" is a ${component.kind}, not a pipeline.`);
	}

	const spec = component.spec as PipelineSpec;
	const lines: string[] = [
		`## ${component.metadata.name}`,
		'',
		`| Field | Value |`,
		`|-------|-------|`,
		`| **ID** | ${component.id} |`,
		`| **Kind** | ${component.kind} |`,
		`| **Description** | ${component.metadata.description} |`,
		`| **Source** | ${component.source} |`,
		`| **Steps** | ${spec.steps.length} |`,
	];

	if (component.metadata.version) {
		lines.push(`| **Version** | ${component.metadata.version} |`);
	}

	if (spec.inputs && Object.keys(spec.inputs).length > 0) {
		lines.push('');
		lines.push('### Inputs');
		for (const [key, input] of Object.entries(spec.inputs)) {
			const def = input.default !== undefined ? ` (default: ${input.default})` : '';
			const desc = input.description ? ` — ${input.description}` : '';
			lines.push(`- **${key}** (${input.type})${def}${desc}`);
		}
	}

	lines.push('');
	lines.push('### Steps');
	for (const step of spec.steps) {
		const parallel = step.parallel ? ' [parallel]' : '';
		const deps = step.dependsOn?.length ? ` (depends on: ${step.dependsOn.join(', ')})` : '';
		lines.push(`- **${step.id}**: \`${step.component}\`${parallel}${deps}`);
		lines.push(`  Task: ${step.task}`);
	}

	return sendComponentMessage(pi, lines.join('\n'));
}

async function handlePipelineRun(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	name: string,
): Promise<void> {
	if (!name.trim()) {
		return sendComponentMessage(pi, 'Usage: /gsd pipeline run <name>');
	}

	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	const component = registry.resolve(name.trim());
	if (!component) {
		return sendComponentMessage(pi, `Pipeline "${name.trim()}" not found.`);
	}

	if (component.kind !== 'pipeline') {
		return sendComponentMessage(pi, `"${name.trim()}" is a ${component.kind}, not a pipeline.`);
	}

	const spec = component.spec as PipelineSpec;
	const validation = validatePipelineSpec(spec);

	if (!validation.valid) {
		const lines: string[] = [
			`## Pipeline "${component.metadata.name}" — Validation Failed`,
			'',
			'Cannot build execution plan due to validation errors:',
			'',
		];
		for (const err of validation.errors) {
			lines.push(`- ${err}`);
		}
		return sendComponentMessage(pi, lines.join('\n'));
	}

	const waves = buildExecutionPlan(spec);
	const lines: string[] = [
		`## Pipeline "${component.metadata.name}" — Execution Plan`,
		'',
		`**Status**: Validated`,
		`**Steps**: ${spec.steps.length}`,
		`**Waves**: ${waves.length}`,
		'',
	];

	if (spec.inputs && Object.keys(spec.inputs).length > 0) {
		lines.push('### Input Parameters');
		for (const [key, input] of Object.entries(spec.inputs)) {
			const def = input.default !== undefined ? ` (default: ${input.default})` : ' (required)';
			lines.push(`- **${key}** (${input.type})${def}`);
		}
		lines.push('');
	}

	lines.push('### Execution Waves');
	for (const wave of waves) {
		const parallel = wave.steps.length > 1 ? ' (parallel)' : '';
		lines.push(`\n**Wave ${wave.waveIndex + 1}**${parallel}`);
		for (const step of wave.steps) {
			const deps = step.dependsOn?.length ? ` [after: ${step.dependsOn.join(', ')}]` : '';
			lines.push(`- **${step.id}** → \`${step.component}\`${deps}`);
			lines.push(`  Task: ${step.task}`);
		}
	}

	lines.push('');
	lines.push('*Dry-run only — pipeline was not executed.*');

	return sendComponentMessage(pi, lines.join('\n'));
}

async function handlePipelineValidate(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	name: string,
): Promise<void> {
	if (!name.trim()) {
		return sendComponentMessage(pi, 'Usage: /gsd pipeline validate <name>');
	}

	const registry = getComponentRegistry(ctx.cwd);
	registry.reload();

	const component = registry.resolve(name.trim());
	if (!component) {
		return sendComponentMessage(pi, `Pipeline "${name.trim()}" not found.`);
	}

	if (component.kind !== 'pipeline') {
		return sendComponentMessage(pi, `"${name.trim()}" is a ${component.kind}, not a pipeline.`);
	}

	const spec = component.spec as PipelineSpec;
	const validation = validatePipelineSpec(spec);

	const lines: string[] = [
		`## Pipeline "${component.metadata.name}" — Validation`,
		'',
		`**Valid**: ${validation.valid ? 'Yes' : 'No'}`,
		`**Steps**: ${spec.steps.length}`,
		'',
	];

	if (validation.errors.length > 0) {
		lines.push('### Errors');
		for (const err of validation.errors) {
			lines.push(`- ${err}`);
		}
	} else {
		lines.push('No issues found. Pipeline is ready for execution.');
	}

	return sendComponentMessage(pi, lines.join('\n'));
}

// ============================================================================
// Component Creation
// ============================================================================

/**
 * Create a new component with scaffold files.
 */
export async function createComponent(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	kind: ComponentKind,
	name: string,
	options?: {
		description?: string;
		scope?: 'project' | 'user';
		model?: string;
		tools?: string[];
		tags?: string[];
	},
): Promise<void> {
	const scope = options?.scope ?? 'project';
	const description = options?.description ?? `A custom ${kind}`;
	const tags = options?.tags ?? [];

	// Determine target directory
	let baseDir: string;
	if (scope === 'project') {
		baseDir = resolve(ctx.cwd, CONFIG_DIR_NAME, kind === 'agent' ? 'agents' : 'skills');
	} else {
		const agentDir = getAgentDir();
		baseDir = join(agentDir, kind === 'agent' ? 'agents' : 'skills');
	}

	const componentDir = join(baseDir, name);

	if (existsSync(componentDir)) {
		return sendComponentMessage(pi, `Component directory already exists: ${componentDir}`);
	}

	// Create directory
	mkdirSync(componentDir, { recursive: true });

	// Write component.yaml
	const yamlContent = buildComponentYaml(kind, name, description, tags, options);
	writeFileSync(join(componentDir, 'component.yaml'), yamlContent, 'utf-8');

	// Write prompt file
	if (kind === 'skill') {
		const skillContent = buildSkillTemplate(name, description);
		writeFileSync(join(componentDir, 'SKILL.md'), skillContent, 'utf-8');

		// Create references directory
		mkdirSync(join(componentDir, 'references'), { recursive: true });
	} else if (kind === 'agent') {
		const agentContent = buildAgentTemplate(name, description);
		writeFileSync(join(componentDir, 'AGENT.md'), agentContent, 'utf-8');
	}

	// Reset registry so new component is discoverable
	resetComponentRegistry();

	const lines = [
		`Created ${kind} "${name}" at ${componentDir}`,
		'',
		'Files:',
		`- ${join(componentDir, 'component.yaml')}`,
	];

	if (kind === 'skill') {
		lines.push(`- ${join(componentDir, 'SKILL.md')} (edit this to add instructions)`);
		lines.push(`- ${join(componentDir, 'references/')} (add reference docs here)`);
	} else if (kind === 'agent') {
		lines.push(`- ${join(componentDir, 'AGENT.md')} (edit this to define behavior)`);
	}

	return sendComponentMessage(pi, lines.join('\n'));
}

// ============================================================================
// Templates
// ============================================================================

function buildComponentYaml(
	kind: ComponentKind,
	name: string,
	description: string,
	tags: string[],
	options?: { model?: string; tools?: string[] },
): string {
	const lines: string[] = [
		'apiVersion: gsd/v1',
		`kind: ${kind}`,
		'metadata:',
		`  name: ${name}`,
		`  description: "${escapeYamlString(description)}"`,
		'  version: 1.0.0',
	];

	if (tags.length > 0) {
		lines.push(`  tags: [${tags.join(', ')}]`);
	}

	lines.push('spec:');

	if (kind === 'skill') {
		lines.push('  prompt: SKILL.md');
	} else if (kind === 'agent') {
		lines.push('  systemPrompt: AGENT.md');
		if (options?.model) {
			lines.push(`  model: ${options.model}`);
		}
		if (options?.tools && options.tools.length > 0) {
			lines.push('  tools:');
			lines.push(`    allow: [${options.tools.join(', ')}]`);
		}
	}

	lines.push('');
	return lines.join('\n');
}

function buildSkillTemplate(name: string, description: string): string {
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

function buildAgentTemplate(name: string, description: string): string {
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
// Helpers
// ============================================================================

function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeYamlString(str: string): string {
	return str.replace(/"/g, '\\"');
}

function sendComponentMessage(
	pi: ExtensionAPI,
	content: string,
	triggerTurn = false,
): void {
	pi.sendMessage(
		{ customType: 'component-system', content, display: !triggerTurn },
		{ triggerTurn },
	);
}
