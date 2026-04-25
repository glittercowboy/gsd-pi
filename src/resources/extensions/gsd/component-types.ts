/**
 * Unified Component Type Definitions
 *
 * Shared metadata for installable/discoverable skills and agents.
 *
 * Replaces the separate type systems in:
 * - packages/pi-coding-agent/src/core/skills.ts (SkillFrontmatter, Skill)
 * - src/resources/extensions/subagent/agents.ts (AgentConfig)
 *
 * Legacy skill and agent formats are supported via backward-compatible loading.
 */

// ============================================================================
// Component Kind
// ============================================================================

/** All supported component types for the first component-system slice. */
export type ComponentKind = 'skill' | 'agent';

/** API version for component.yaml spec */
export type ComponentApiVersion = 'gsd/v1';

// ============================================================================
// Component Metadata
// ============================================================================

export interface ComponentAuthor {
	name: string;
	email?: string;
	url?: string;
}

export interface ComponentMetadata {
	/** Component name (lowercase a-z, 0-9, hyphens). Required. */
	name: string;

	/** Human-readable description. Required. */
	description: string;

	/** Namespace for plugin-sourced components (e.g., "my-plugin"). */
	namespace?: string;

	/** Semver version string. */
	version?: string;

	/** Author information. */
	author?: ComponentAuthor;

	/** Searchable tags. */
	tags?: string[];

	/** SPDX license identifier. */
	license?: string;
}

// ============================================================================
// Skill Spec
// ============================================================================

export interface SkillSpec {
	/** Path to the prompt content file (relative to component dir). */
	prompt: string;

	/** If true, skill is excluded from LLM system prompt (invoke-only). */
	disableModelInvocation?: boolean;
}

// ============================================================================
// Agent Spec
// ============================================================================

export interface AgentToolConfig {
	/** Tools the agent is allowed to use. If set, only these tools are available. */
	allow?: string[];

	/** Tools the agent is explicitly denied. Applied after allow. */
	deny?: string[];
}

export interface AgentContextConfig {
	/** Files to always include in the agent's context. */
	alwaysInclude?: string[];

	/** Whether to inject project context (project files, structure). */
	injectProjectContext?: boolean;

	/** Whether to inject current git status. */
	injectGitStatus?: boolean;
}

export interface AgentOutputSchema {
	type: 'object' | 'string';
	properties?: Record<string, { type: string; items?: { type: string }; description?: string }>;
	required?: string[];
}

export interface AgentSpec {
	/** Path to the system prompt file (relative to component dir). */
	systemPrompt: string;

	/** Model override (e.g., "claude-sonnet-4-6"). */
	model?: string;

	/** Fallback models to try if primary fails. */
	modelFallbacks?: string[];

	/** Tool access configuration. */
	tools?: AgentToolConfig | string[];

	/** Maximum number of turns before the agent is stopped. */
	maxTurns?: number;

	/** Maximum tokens budget per invocation. */
	maxTokens?: number;

	/** Hard timeout in minutes. */
	timeoutMinutes?: number;

	/** Temperature override. */
	temperature?: number;

	/** Thinking level override. */
	thinking?: 'off' | 'minimal' | 'standard' | 'full';

	/** Output format preference. */
	outputFormat?: 'text' | 'structured' | 'markdown';

	/** Context injection configuration. */
	context?: AgentContextConfig;

	/** Isolation mode for execution. */
	isolation?: 'none' | 'worktree';

	/** Merge strategy when isolation is used. */
	mergeStrategy?: 'patch' | 'squash' | 'manual';

	/** Whether the agent accepts {previous} input from chain mode. */
	acceptsInput?: boolean;

	/** Structured output contract. */
	outputSchema?: AgentOutputSchema;

	/** Name of another agent to inherit configuration from. */
	extends?: string;
}

// ============================================================================
// Dependency & Compatibility
// ============================================================================

export interface ComponentDependencies {
	/** Required skills that must be installed. */
	skills?: string[];

	/** Required agents that must be installed. */
	agents?: string[];

	/** Required MCP servers. */
	mcpServers?: string[];
}

export interface ComponentCompatibility {
	/** Minimum GSD version (semver range). */
	gsd?: string;

	/** Minimum Node.js version (semver range). */
	node?: string;
}

// ============================================================================
// Agent Routing
// ============================================================================

export interface AgentRoutingRule {
	/** Natural-language condition for when this agent should be used. */
	when: string;

	/** Confidence level for this rule. */
	confidence?: 'low' | 'medium' | 'high';
}

export type ComponentSpec = SkillSpec | AgentSpec;

// ============================================================================
// Full Component Definition
// ============================================================================

/**
 * Complete component.yaml definition.
 * This is the parsed representation of a component.yaml file.
 */
export interface ComponentDefinition {
	apiVersion: ComponentApiVersion;
	kind: ComponentKind;
	metadata: ComponentMetadata;
	spec: ComponentSpec;

	/** Dependencies on other components. */
	requires?: ComponentDependencies;

	/** Version compatibility constraints. */
	compatibility?: ComponentCompatibility;

	/** Agent routing rules (only for kind: agent). */
	routing?: AgentRoutingRule[];
}

// ============================================================================
// Resolved Component (Runtime)
// ============================================================================

/** Source of a loaded component */
export type ComponentSource = 'user' | 'project' | 'builtin' | 'plugin' | 'path';

/**
 * A fully resolved component at runtime.
 * Combines the definition with resolution metadata.
 */
export interface Component {
	/** Unique identifier: `${namespace}:${name}` or bare `name`. */
	id: string;

	/** Component kind. */
	kind: ComponentKind;

	/** Component metadata. */
	metadata: ComponentMetadata;

	/** Kind-specific specification. */
	spec: ComponentSpec;

	/** Dependencies. */
	requires?: ComponentDependencies;

	/** Compatibility constraints. */
	compatibility?: ComponentCompatibility;

	/** Routing rules (agents only). */
	routing?: AgentRoutingRule[];

	/** Absolute path to the component directory. */
	dirPath: string;

	/** Absolute path to the definition file (component.yaml or SKILL.md or agent.md). */
	filePath: string;

	/** How this component was discovered. */
	source: ComponentSource;

	/** Format of the original definition. */
	format: 'component-yaml' | 'skill-md' | 'agent-md';

	/** Whether the component is currently enabled. */
	enabled: boolean;
}

// ============================================================================
// Registry Types
// ============================================================================

export interface ComponentFilter {
	/** Filter by kind. */
	kind?: ComponentKind | ComponentKind[];

	/** Filter by source. */
	source?: ComponentSource | ComponentSource[];

	/** Filter by namespace. */
	namespace?: string;

	/** Filter by tags (any match). */
	tags?: string[];

	/** Text search across name and description. */
	search?: string;

	/** Only enabled components. Default: true. */
	enabledOnly?: boolean;
}

export interface ComponentDiagnostic {
	type: 'warning' | 'error' | 'collision';
	message: string;
	componentId?: string;
	path?: string;
	collision?: {
		name: string;
		winnerPath: string;
		loserPath: string;
		winnerSource?: string;
		loserSource?: string;
	};
}

// ============================================================================
// Validation
// ============================================================================

/** Max name length per spec */
export const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Valid name pattern: lowercase a-z, 0-9, hyphens, no leading/trailing/consecutive hyphens */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate a component name.
 * @returns Array of error messages (empty if valid).
 */
export function validateComponentName(name: string): string[] {
	const errors: string[] = [];

	if (!name || name.trim() === '') {
		errors.push('name is required');
		return errors;
	}

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (name.includes('--')) {
		errors.push('name must not contain consecutive hyphens');
	}

	if (!NAME_PATTERN.test(name)) {
		if (/[A-Z]/.test(name)) {
			errors.push('name must be lowercase');
		} else if (name.startsWith('-') || name.endsWith('-')) {
			errors.push('name must not start or end with a hyphen');
		} else if (!name.includes('--')) {
			errors.push('name must contain only lowercase a-z, 0-9, and hyphens');
		}
	}

	return errors;
}

/**
 * Validate a component description.
 * @returns Array of error messages (empty if valid).
 */
export function validateComponentDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === '') {
		errors.push('description is required');
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

/**
 * Compute the canonical ID for a component.
 */
export function computeComponentId(name: string, namespace?: string): string {
	return namespace ? `${namespace}:${name}` : name;
}
