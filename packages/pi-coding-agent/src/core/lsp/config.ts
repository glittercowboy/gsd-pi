import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { globSync } from "glob";
import { CONFIG_DIR_NAME } from "../../config.js";
import { isRecord } from "./helpers.js";
import type { ServerConfig } from "./types.js";

const require = createRequire(import.meta.url);
const DEFAULTS = require("./defaults.json") as Record<string, Partial<ServerConfig>>;

/** Map legacy server keys to their current names so user overrides still merge. */
const LEGACY_ALIASES: Record<string, string> = {
	"kotlin-language-server": "kotlin-lsp",
};

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	/** Idle timeout in milliseconds. If set, LSP clients will be shutdown after this period of inactivity. Disabled by default. */
	idleTimeoutMs?: number;
}

// =============================================================================
// Default Server Configuration Loading
// =============================================================================

const PID_TOKEN = "$PID";

interface NormalizedConfig {
	servers: Record<string, Partial<ServerConfig>>;
	idleTimeoutMs?: number;
}

function parseConfigContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;

	const idleTimeoutMs = typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : undefined;
	const rawServers = value.servers;

	if (isRecord(rawServers)) {
		return { servers: rawServers as Record<string, Partial<ServerConfig>>, idleTimeoutMs };
	}

	const servers = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs")) as Record<
		string,
		Partial<ServerConfig>
	>;

	return { servers, idleTimeoutMs };
}

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : null;
}

function normalizeServerConfig(name: string, config: Partial<ServerConfig>): ServerConfig | null {
	const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
	const fileTypes = normalizeStringArray(config.fileTypes);
	const rootMarkers = normalizeStringArray(config.rootMarkers);

	if (!command || !fileTypes || !rootMarkers) {
		return null;
	}

	const args = Array.isArray(config.args)
		? config.args.filter((entry): entry is string => typeof entry === "string")
		: undefined;

	return {
		...config,
		command,
		args,
		fileTypes,
		rootMarkers,
	};
}

function readConfigFile(filePath: string): NormalizedConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseConfigContent(content, filePath);
		return normalizeConfig(parsed);
	} catch {
		return null;
	}
}

function coerceServerConfigs(servers: Record<string, Partial<ServerConfig>>): Record<string, ServerConfig> {
	const result: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		const normalized = normalizeServerConfig(name, config);
		if (normalized) {
			result[name] = normalized;
		}
	}
	return result;
}

function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, Partial<ServerConfig>>,
): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [rawName, config] of Object.entries(overrides)) {
		const name = LEGACY_ALIASES[rawName] ?? rawName;
		if (merged[name]) {
			const candidate = { ...merged[name], ...config };
			const normalized = normalizeServerConfig(name, candidate);
			if (normalized) {
				merged[name] = normalized;
			}
		} else {
			const normalized = normalizeServerConfig(name, config);
			if (normalized) {
				merged[name] = normalized;
			}
		}
	}
	return merged;
}

function applyRuntimeDefaults(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const updated: Record<string, ServerConfig> = { ...servers };

	if (updated.omnisharp?.args) {
		const args = updated.omnisharp.args.map((arg: string) => (arg === PID_TOKEN ? String(process.pid) : arg));
		updated.omnisharp = { ...updated.omnisharp, args };
	}

	return updated;
}

// =============================================================================
// Configuration Loading
// =============================================================================

export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	for (const marker of markers) {
		if (marker.includes("*")) {
			try {
				const matches = globSync(marker, { cwd, nodir: false });
				if (matches.length > 0) {
					return true;
				}
			} catch {
				// Failed to resolve glob root marker
			}
			continue;
		}
		const filePath = path.join(cwd, marker);
		if (fs.existsSync(filePath)) {
			return true;
		}
	}
	return false;
}

// =============================================================================
// Local Binary Resolution
// =============================================================================

const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDirs: string[] }> = [
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDirs: ["node_modules/.bin"] },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDirs: [".venv/bin", ".venv/Scripts"] },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDirs: ["venv/bin", "venv/Scripts"] },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDirs: [".env/bin", ".env/Scripts"] },
	{ markers: ["Gemfile", "Gemfile.lock"], binDirs: ["vendor/bundle/bin"] },
	{ markers: ["Gemfile", "Gemfile.lock"], binDirs: ["bin"] },
	{ markers: ["go.mod", "go.sum"], binDirs: ["bin"] },
];

function getWindowsBinaryCandidates(command: string): string[] {
	const ext = path.extname(command).toLowerCase();
	if (ext) {
		return [command];
	}

	return [
		command,
		`${command}.cmd`,
		`${command}.bat`,
		`${command}.exe`,
	];
}

export function resolveLocalBinaryPath(command: string, cwd: string, isWindows: boolean): string | null {
	for (const { markers, binDirs } of LOCAL_BIN_PATHS) {
		if (!hasRootMarkers(cwd, markers)) continue;

		for (const binDir of binDirs) {
			const basePath = path.join(cwd, binDir, command);
			const candidates = isWindows ? getWindowsBinaryCandidates(basePath) : [basePath];

			for (const candidate of candidates) {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}
	}

	return null;
}

export function which(command: string): string | null {
	// On Windows, prefer `where.exe` over `which` — MSYS/Git Bash's `which`
	// returns POSIX paths (/c/Users/...) that Node's spawn() can't execute.
	// `where.exe` returns native Windows paths (C:\Users\...).
	const isWindows = process.platform === "win32";
	const cmd = isWindows ? "where.exe" : "which";
	const result = spawnSync(cmd, [command], { encoding: "utf-8", shell: isWindows });
	if (result.status !== 0) return null;
	// `where.exe` may return multiple lines — take the first
	const resolved = result.stdout.trim().split(/\r?\n/)[0]?.trim();
	return resolved || null;
}

export function resolveCommand(command: string, cwd: string): string | null {
	const localPath = resolveLocalBinaryPath(command, cwd, process.platform === "win32");
	if (localPath) return localPath;
	return which(command);
}

/**
 * Configuration file search paths (in priority order).
 */
function getConfigPaths(cwd: string): string[] {
	const filenames = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
	const paths: string[] = [];

	// Project root files (highest priority)
	for (const filename of filenames) {
		paths.push(path.join(cwd, filename));
	}

	// Project config directory
	const projectConfigDir = path.join(cwd, CONFIG_DIR_NAME);
	for (const filename of filenames) {
		paths.push(path.join(projectConfigDir, filename));
	}

	// User config directory
	const userConfigDir = path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
	for (const filename of filenames) {
		paths.push(path.join(userConfigDir, filename));
	}

	// User home root files (lowest priority fallback)
	for (const filename of filenames) {
		paths.push(path.join(os.homedir(), filename));
	}

	return paths;
}

/**
 * Load LSP configuration.
 *
 * Priority (highest to lowest):
 * 1. Project root: lsp.json/.lsp.json/lsp.yml/.lsp.yml/lsp.yaml/.lsp.yaml
 * 2. Project config dir: {CONFIG_DIR_NAME}/lsp.* (+ hidden variants)
 * 3. User config dir: ~/{CONFIG_DIR_NAME}/agent/lsp.* (+ hidden variants)
 * 4. User home root: ~/lsp.*, ~/.lsp.*
 * 5. Auto-detect from project markers + available binaries
 */
export function loadConfig(cwd: string): LspConfig {
	let mergedServers = coerceServerConfigs(DEFAULTS);

	const configPaths = getConfigPaths(cwd).reverse();
	let hasOverrides = false;

	let idleTimeoutMs: number | undefined;
	for (const configPath of configPaths) {
		const parsed = readConfigFile(configPath);
		if (!parsed) continue;
		const hasServerOverrides = Object.keys(parsed.servers).length > 0;
		if (hasServerOverrides) {
			hasOverrides = true;
			mergedServers = mergeServers(mergedServers, parsed.servers);
		}
		if (parsed.idleTimeoutMs !== undefined) {
			idleTimeoutMs = parsed.idleTimeoutMs;
		}
	}

	if (!hasOverrides) {
		const detected: Record<string, ServerConfig> = {};
		const defaultsWithRuntime = applyRuntimeDefaults(mergedServers);

		for (const [name, config] of Object.entries(defaultsWithRuntime)) {
			if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
			const resolved = resolveCommand(config.command, cwd);
			if (!resolved) continue;
			detected[name] = { ...config, resolvedCommand: resolved };
		}

		return { servers: detected, idleTimeoutMs };
	}

	const mergedWithRuntime = applyRuntimeDefaults(mergedServers);
	const available: Record<string, ServerConfig> = {};

	for (const [name, config] of Object.entries(mergedWithRuntime)) {
		if (config.disabled) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (!resolved) continue;
		available[name] = { ...config, resolvedCommand: resolved };
	}

	return { servers: available, idleTimeoutMs };
}

// =============================================================================
// Server Selection
// =============================================================================

export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const fileName = path.basename(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		const supportsFile = serverConfig.fileTypes.some(fileType => {
			const normalized = fileType.toLowerCase();
			return normalized === ext || normalized === fileName;
		});

		if (supportsFile) {
			matches.push([name, serverConfig]);
		}
	}

	// Sort: primary servers (non-linters) first, then linters
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	return getServersForFile(config, filePath)[0] ?? null;
}
