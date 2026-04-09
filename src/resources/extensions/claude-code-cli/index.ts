/**
 * Claude Code CLI Provider Extension
 *
 * Registers a model provider that delegates inference to the user's
 * locally-installed Claude Code CLI via the official Agent SDK.
 *
 * Users with a Claude Code subscription (Pro/Max/Team) get access to
 * subsidized inference through GSD's UI — no API key required.
 *
 * TOS-compliant: uses Anthropic's official `@anthropic-ai/claude-agent-sdk`,
 * never touches credentials, never offers a login flow.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { CLAUDE_CODE_MODELS } from "./models.js";
import { isClaudeCodeReady } from "./readiness.js";
import { streamViaClaudeCode } from "./stream-adapter.js";

export default function claudeCodeCli(pi: ExtensionAPI) {
	pi.registerProvider("claude-code", {
		authMode: "externalCli",
		api: "anthropic-messages",
		baseUrl: "local://claude-code",
		isReady: isClaudeCodeReady,
		streamSimple: streamViaClaudeCode,
		models: CLAUDE_CODE_MODELS,
	});
}
