import type { ProviderAuthMode } from "../../core/model-registry.js";

export type ProviderSetupAction =
	| { kind: "oauth-login" }
	| { kind: "status"; message: string };

export function getProviderSetupAction(options: {
	provider: string;
	authMode: ProviderAuthMode;
	hasAuth: boolean;
}): ProviderSetupAction {
	const { provider, authMode, hasAuth } = options;

	if (authMode === "oauth") {
		return { kind: "oauth-login" };
	}

	if (authMode === "none") {
		return {
			kind: "status",
			message: `${provider} does not need auth setup. Use /model to select it.`,
		};
	}

	if (authMode === "externalCli") {
		return {
			kind: "status",
			message: hasAuth
				? `${provider} is already authenticated. Use /model to select it.`
				: `${provider} uses external CLI auth. Sign in with the provider CLI, then use /model.`,
		};
	}

	return {
		kind: "status",
		message: hasAuth
			? `${provider} already has credentials configured. Use /model to select it.`
			: `${provider} uses API-key auth, not OAuth. Configure its credentials, then use /model.`,
	};
}
