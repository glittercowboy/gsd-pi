/**
 * Claude Code wire-format spoofing helpers.
 *
 * Some Anthropic-compatible proxies validate that requests look like they
 * came from the real Claude Code CLI. This module centralises the constants
 * and helpers used to reshape outgoing requests so they pass that check.
 *
 * See temp/CLAUDIBLE_PATCH.md for the reverse-engineered validation rules.
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";

/** Version string Claude Code stamps in its billing header. Refresh when CC upgrades. */
export const CLAUDE_CODE_VERSION = "2.1.112.c44";

/** User-Agent Claude Code sends on /v1/messages calls. */
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.112 (external, sdk-cli)";

/** Anchor block 1 — must appear verbatim as system[1]. */
export const CC_AGENT_MARKER =
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Anchor block 2 — last 950+ chars of Claude Code's actual system prompt.
 * Proxy validates that this content is present at the end of system[2].
 *
 * IMPORTANT: when Claude Code upgrades major version, the model IDs/version
 * strings inside this constant become stale. Re-extract from a fresh HAR
 * dump (see temp/CLAUDIBLE_PATCH.md §6 "Maintenance").
 */
export const CC_SYSTEM_TAIL = `xact model ID is claude-sonnet-4-6.
 - Assistant knowledge cutoff is August 2025.
 - The most recent Claude model family is Claude 4.X. Model IDs — Opus 4.7: 'claude-opus-4-7', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.
 - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).
 - Fast mode for Claude Code uses Claude Opus 4.6 with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is only available on Opus 4.6.

When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.

Length limits: keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless the task requires more detail.`;

/** Beta header used by Claude Code for Haiku-class models. */
export const CC_BETA_HAIKU =
	"interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219";

/** Beta header used by Claude Code for Sonnet/Opus (adds the `effort` beta). */
export const CC_BETA_SONNET_OPUS =
	"claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24";

/** Stable per-host hash matching CC's `metadata.user_id.device_id` shape. */
let cachedDeviceId: string | undefined;
function getDeviceId(): string {
	if (cachedDeviceId) return cachedDeviceId;
	cachedDeviceId = createHash("sha256")
		.update(`${userInfo().username}@${hostname()}`)
		.digest("hex");
	return cachedDeviceId;
}

/** UUID stable per gsd-2 session — caller passes the session id from runtime. */
const sessionUuidMap = new Map<string, string>();
export function getSessionUuid(sessionId: string | undefined): string {
	if (!sessionId) return randomUUID();
	let v = sessionUuidMap.get(sessionId);
	if (!v) {
		v = randomUUID();
		sessionUuidMap.set(sessionId, v);
	}
	return v;
}

/** Build the billing-header literal that occupies system[0]. */
export function buildBillingHeader(sessionUuid: string): string {
	const cch = createHash("sha1")
		.update(sessionUuid)
		.digest("hex")
		.slice(0, 5);
	return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

/** Build CC's `metadata.user_id` — a JSON-encoded string with device/session ids. */
export function buildClaudeCodeUserId(sessionUuid: string): string {
	return JSON.stringify({
		device_id: getDeviceId(),
		account_uuid: "",
		session_id: sessionUuid,
	});
}

type CacheControl = { type: string };
type SystemBlock = { type: "text"; text: string; cache_control?: CacheControl };

/** Build the 3 anchor system blocks — caller appends user system prompt after. */
export function buildAnchorSystemBlocks(
	sessionUuid: string,
	cacheControl: CacheControl | undefined,
): SystemBlock[] {
	return [
		{ type: "text", text: buildBillingHeader(sessionUuid) },
		{
			type: "text",
			text: CC_AGENT_MARKER,
			...(cacheControl ? { cache_control: cacheControl } : {}),
		},
		{
			type: "text",
			text: CC_SYSTEM_TAIL,
			...(cacheControl ? { cache_control: cacheControl } : {}),
		},
	];
}

/** True if the model needs the `effort` beta + adaptive thinking (Sonnet/Opus). */
export function isAdaptiveThinkingModel(modelId: string): boolean {
	return modelId.includes("sonnet") || modelId.includes("opus");
}

/** Header overrides that real Claude Code stamps and the proxy expects. */
export function buildSpoofHeaders(
	sessionUuid: string,
	modelId: string,
): Record<string, string> {
	return {
		"User-Agent": CLAUDE_CODE_USER_AGENT,
		"anthropic-beta": isAdaptiveThinkingModel(modelId)
			? CC_BETA_SONNET_OPUS
			: CC_BETA_HAIKU,
		"x-app": "cli",
		"X-Claude-Code-Session-Id": sessionUuid,
	};
}

/** Detect any provider that needs CC spoofing. */
export function isCcSpoofProvider(provider: string, headers?: Record<string, string>): boolean {
	if (provider === "claudible") return true;
	if (headers && (headers["X-Spoof-Claude-Code"] || headers["x-spoof-claude-code"])) {
		return true;
	}
	return false;
}
