/**
 * Model role definitions for role-based model routing.
 *
 * Named roles (default, smol, slow, vision, plan, commit) map to specific models,
 * allowing different subsystems to use appropriately-sized models.
 */

export type ModelRole = "default" | "smol" | "slow" | "vision" | "plan" | "commit";

export const MODEL_ROLES: Record<ModelRole, { tag: string; displayName: string; description: string }> = {
	default: {
		tag: "default",
		displayName: "Default",
		description: "Primary model for general coding tasks",
	},
	smol: {
		tag: "smol",
		displayName: "Small",
		description: "Fast, cheap model for simple tasks (titles, summaries, commit messages)",
	},
	slow: {
		tag: "slow",
		displayName: "Slow",
		description: "Large reasoning model for complex analysis and planning",
	},
	vision: {
		tag: "vision",
		displayName: "Vision",
		description: "Model with image understanding capabilities",
	},
	plan: {
		tag: "plan",
		displayName: "Plan",
		description: "Model for planning and architectural decisions",
	},
	commit: {
		tag: "commit",
		displayName: "Commit",
		description: "Model for generating commit messages and changelogs",
	},
};

export const MODEL_ROLE_IDS: ModelRole[] = Object.keys(MODEL_ROLES) as ModelRole[];

/** Check if a string is a valid model role */
export function isModelRole(value: string): value is ModelRole {
	return MODEL_ROLE_IDS.includes(value as ModelRole);
}

/** Role alias prefix used in model specifications (e.g., "pi/smol") */
export const ROLE_ALIAS_PREFIX = "pi/";

/** Check if a model value is a role alias (e.g., "pi/smol") */
export function isRoleAlias(value: string): boolean {
	if (!value.startsWith(ROLE_ALIAS_PREFIX)) return false;
	const role = value.slice(ROLE_ALIAS_PREFIX.length);
	return isModelRole(role);
}

/** Extract the role from a role alias (e.g., "pi/smol" -> "smol") */
export function extractRoleFromAlias(value: string): ModelRole | undefined {
	if (!value.startsWith(ROLE_ALIAS_PREFIX)) return undefined;
	const role = value.slice(ROLE_ALIAS_PREFIX.length);
	return isModelRole(role) ? role : undefined;
}
