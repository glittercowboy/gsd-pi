/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execFileSync } from "child_process";
import { COMMAND_EXECUTION_TIMEOUT_MS } from "./constants.js";

const SHELL_OPERATORS = /[;|&`$><]/;

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();

export const SAFE_COMMAND_PREFIXES = [
	"pass",
	"op",
	"aws",
	"gcloud",
	"vault",
	"security",
	"gpg",
	"bw",
	"gopass",
	"lpass",
];

/**
 * Active command prefix allowlist. Defaults to SAFE_COMMAND_PREFIXES but can be
 * overridden via setAllowedCommandPrefixes() (called from settings or env var).
 */
let activeCommandPrefixes: string[] = SAFE_COMMAND_PREFIXES;

/**
 * Replace the active command prefix allowlist.
 * Called during initialization when the user has configured `allowedCommandPrefixes`
 * in global settings.json or via the GSD_ALLOWED_COMMAND_PREFIXES env var.
 */
export function setAllowedCommandPrefixes(prefixes: string[]): void {
	if (prefixes.length === 0) {
		process.stderr.write("[resolve-config-value] Warning: empty command prefix allowlist — all !commands will be blocked\n");
	}
	activeCommandPrefixes = prefixes;
	clearConfigValueCache();
}

/** Get the currently active command prefix allowlist. */
export function getAllowedCommandPrefixes(): readonly string[] {
	return activeCommandPrefixes;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const command = commandConfig.slice(1);
	const tokens = command.split(/\s+/).filter(Boolean);
	const firstToken = tokens[0];
	if (!activeCommandPrefixes.includes(firstToken)) {
		process.stderr.write(`[resolve-config-value] Blocked disallowed command: "${firstToken}". Allowed: ${activeCommandPrefixes.join(", ")}\n`);
		commandResultCache.set(commandConfig, undefined);
		return undefined;
	}

	if (SHELL_OPERATORS.test(command)) {
		process.stderr.write(`[resolve-config-value] Blocked shell operators in command: "${command}"\n`);
		commandResultCache.set(commandConfig, undefined);
		return undefined;
	}

	let result: string | undefined;
	try {
		const output = execFileSync(firstToken, tokens.slice(1), {
			encoding: "utf-8",
			timeout: COMMAND_EXECUTION_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		result = output.trim() || undefined;
	} catch {
		result = undefined;
	}

	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
