/**
 * Agent configuration resolution and inheritance.
 */

import * as path from 'node:path';
import type { AgentSpec, AgentToolConfig, Component } from './component-types.js';

export interface ResolvedAgentConfig {
	name: string;
	model?: string;
	modelFallbacks: string[];
	tools: string[];
	deniedTools: string[];
	maxTurns: number;
	maxTokens?: number;
	timeoutMinutes: number;
	temperature?: number;
	thinking: 'off' | 'minimal' | 'standard' | 'full';
	outputFormat: 'text' | 'structured' | 'markdown';
	isolation: 'none' | 'worktree';
	systemPromptPath: string;
	contextFiles: string[];
	extends?: string;
}

const DEFAULTS: Omit<ResolvedAgentConfig, 'name' | 'systemPromptPath'> = {
	modelFallbacks: [],
	tools: [],
	deniedTools: [],
	maxTurns: 50,
	timeoutMinutes: 15,
	thinking: 'standard',
	outputFormat: 'text',
	isolation: 'none',
	contextFiles: [],
};

function extractTools(tools: AgentToolConfig | string[] | undefined): { allow: string[]; deny: string[] } {
	if (!tools) return { allow: [], deny: [] };
	if (Array.isArray(tools)) return { allow: [...tools], deny: [] };
	return {
		allow: tools.allow ? [...tools.allow] : [],
		deny: tools.deny ? [...tools.deny] : [],
	};
}

function specToConfig(spec: AgentSpec, name: string, dirPath: string): ResolvedAgentConfig {
	const { allow, deny } = extractTools(spec.tools);

	return {
		...DEFAULTS,
		name,
		model: spec.model,
		modelFallbacks: spec.modelFallbacks ? [...spec.modelFallbacks] : [],
		tools: allow,
		deniedTools: deny,
		maxTurns: spec.maxTurns ?? DEFAULTS.maxTurns,
		maxTokens: spec.maxTokens,
		timeoutMinutes: spec.timeoutMinutes ?? DEFAULTS.timeoutMinutes,
		temperature: spec.temperature,
		thinking: spec.thinking ?? DEFAULTS.thinking,
		outputFormat: spec.outputFormat ?? DEFAULTS.outputFormat,
		isolation: spec.isolation ?? DEFAULTS.isolation,
		systemPromptPath: path.resolve(dirPath, spec.systemPrompt),
		contextFiles: spec.context?.alwaysInclude ? [...spec.context.alwaysInclude] : [],
		extends: spec.extends,
	};
}

export function resolveAgentConfig(
	agent: Component,
	registry?: { resolve: (ref: string) => Component | undefined },
): ResolvedAgentConfig {
	const spec = agent.spec as AgentSpec;
	const config = specToConfig(spec, agent.metadata.name, agent.dirPath);

	if (spec.extends && registry) {
		const parent = registry.resolve(spec.extends);
		if (parent && parent.kind === 'agent') {
			const parentConfig = resolveAgentConfig(parent, registry);
			return mergeAgentConfigs(parentConfig, spec, agent.dirPath);
		}
	}

	return config;
}

export function mergeAgentConfigs(
	parent: ResolvedAgentConfig,
	child: Partial<AgentSpec>,
	childDirPath: string,
): ResolvedAgentConfig {
	const { allow, deny } = extractTools(child.tools);

	return {
		...parent,
		model: child.model ?? parent.model,
		modelFallbacks: child.modelFallbacks ? [...child.modelFallbacks] : parent.modelFallbacks,
		tools: allow.length > 0 ? allow : parent.tools,
		deniedTools: deny.length > 0 ? deny : parent.deniedTools,
		maxTurns: child.maxTurns ?? parent.maxTurns,
		maxTokens: child.maxTokens ?? parent.maxTokens,
		timeoutMinutes: child.timeoutMinutes ?? parent.timeoutMinutes,
		temperature: child.temperature ?? parent.temperature,
		thinking: child.thinking ?? parent.thinking,
		outputFormat: child.outputFormat ?? parent.outputFormat,
		isolation: child.isolation ?? parent.isolation,
		systemPromptPath: child.systemPrompt
			? path.resolve(childDirPath, child.systemPrompt)
			: parent.systemPromptPath,
		contextFiles: child.context?.alwaysInclude
			? [...child.context.alwaysInclude]
			: parent.contextFiles,
		extends: child.extends ?? parent.extends,
	};
}
