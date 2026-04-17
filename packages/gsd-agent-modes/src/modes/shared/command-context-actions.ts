/**
 * Default (headless) implementations of ExtensionCommandContextActions.
 *
 * These delegate directly to AgentSession without any UI side-effects.
 * Interactive mode layers TUI-specific behavior on top of these.
 * RPC and print modes use them as-is.
 */

import type { AgentSession } from "@gsd/agent-core";
import type { ExtensionCommandContextActions } from "@gsd/agent-types";

/**
 * Create the default set of command context actions that simply delegate
 * to the corresponding AgentSession methods.
 *
 * Callers can spread the result and override individual actions to add
 * mode-specific behavior (e.g., interactive mode clears TUI state after
 * forking).
 */
export function createDefaultCommandContextActions(session: AgentSession): ExtensionCommandContextActions {
	return {
		waitForIdle: () => session.agent.waitForIdle(),

		newSession: async (options) => {
			const success = await session.newSession(options);
			return { cancelled: !success };
		},

		fork: async (entryId) => {
			const result = await session.fork(entryId);
			return { cancelled: result.cancelled };
		},

		navigateTree: async (targetId, options) => {
			const result = await session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},

		switchSession: async (sessionPath) => {
			const success = await session.switchSession(sessionPath);
			return { cancelled: !success };
		},

		reload: async () => {
			await session.reload();
		},
	};
}
