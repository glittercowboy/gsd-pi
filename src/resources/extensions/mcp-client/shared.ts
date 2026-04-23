import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { buildHttpTransportOpts } from "./auth.js";
import type { McpHttpAuthConfig } from "./auth.js";

export interface McpServerConfig {
	name: string;
	transport: "stdio" | "http" | "unknown";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	cwd?: string;
	/** Static headers for HTTP transport (supports ${VAR} env resolution). */
	headers?: Record<string, string>;
	/** OAuth config for HTTP transport. */
	oauth?: McpHttpAuthConfig["oauth"];
	sourcePath: string;
	sourceKey: "mcpServers" | "servers";
}

export interface McpToolSchema {
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
}

interface ManagedConnection {
	client: Client;
	transport: StdioClientTransport | StreamableHTTPClientTransport;
}

export interface McpConfigIssue {
	path: string;
	severity: "warning" | "error";
	message: string;
	detail?: string;
}

export interface McpShadowedServer {
	name: string;
	path: string;
	winnerPath: string;
}

export interface McpConfigSnapshot {
	baseDir: string;
	checkedPaths: string[];
	servers: McpServerConfig[];
	issues: McpConfigIssue[];
	shadowed: McpShadowedServer[];
}

export interface McpServerDiagnostic {
	server: McpServerConfig;
	status: "ok" | "error";
	summary: string;
	detail?: string;
	toolCount?: number;
	tools?: McpToolSchema[];
	durationMs: number;
}

export interface McpDiagnosticReport {
	baseDir: string;
	requestedServer?: string;
	requestedServerFound: boolean;
	config: McpConfigSnapshot;
	servers: McpServerDiagnostic[];
	summary: {
		total: number;
		ok: number;
		error: number;
	};
}

interface DiscoverOptions {
	baseDir?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	useCache?: boolean;
}

interface DiagnosticOptions {
	baseDir?: string;
	refresh?: boolean;
	server?: string;
	timeoutMs?: number;
	verbose?: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 15_000;

const connections = new Map<string, ManagedConnection>();
const toolCache = new Map<string, McpToolSchema[]>();
let configCache: McpConfigSnapshot | null = null;

function resolveBaseDir(baseDir: string = process.cwd()): string {
	return resolve(baseDir);
}

function cacheKey(baseDir: string, name: string): string {
	return `${resolveBaseDir(baseDir)}::${name}`;
}

function configPaths(baseDir: string): string[] {
	return [
		join(baseDir, ".mcp.json"),
		join(baseDir, ".gsd", "mcp.json"),
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeArgs(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const args = value.filter((item): item is string => typeof item === "string");
	return args.length > 0 ? args : undefined;
}

function sanitizeEnv(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function extractServersObject(
	data: Record<string, unknown>,
	configPath: string,
	issues: McpConfigIssue[],
): { key: "mcpServers" | "servers"; value: Record<string, unknown> } | null {
	if (isRecord(data.mcpServers)) return { key: "mcpServers", value: data.mcpServers };
	if (isRecord(data.servers)) return { key: "servers", value: data.servers };

	if ("mcpServers" in data || "servers" in data) {
		issues.push({
			path: configPath,
			severity: "error",
			message: "MCP config must define an object under `mcpServers` or `servers`.",
		});
		return null;
	}

	issues.push({
		path: configPath,
		severity: "warning",
		message: "Config file exists but defines no `mcpServers` or `servers` entries.",
	});
	return null;
}

function readConfigSnapshot(baseDir: string = process.cwd()): McpConfigSnapshot {
	const resolvedBaseDir = resolveBaseDir(baseDir);
	if (configCache?.baseDir === resolvedBaseDir) return configCache;

	const checkedPaths = configPaths(resolvedBaseDir);
	const servers: McpServerConfig[] = [];
	const issues: McpConfigIssue[] = [];
	const shadowed: McpShadowedServer[] = [];
	const seen = new Map<string, McpServerConfig>();

	for (const configPath of checkedPaths) {
		if (!existsSync(configPath)) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error: unknown) {
			issues.push({
				path: configPath,
				severity: "error",
				message: "Invalid JSON.",
				detail: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		if (!isRecord(parsed)) {
			issues.push({
				path: configPath,
				severity: "error",
				message: "MCP config root must be a JSON object.",
			});
			continue;
		}

		const serverGroup = extractServersObject(parsed, configPath, issues);
		if (!serverGroup) continue;

		for (const [name, rawConfig] of Object.entries(serverGroup.value)) {
			if (!isRecord(rawConfig)) {
				issues.push({
					path: configPath,
					severity: "error",
					message: `Server "${name}" must be a JSON object.`,
				});
				continue;
			}

			const hasCommand = typeof rawConfig.command === "string";
			const hasUrl = typeof rawConfig.url === "string";
			const transport: McpServerConfig["transport"] = hasCommand
				? "stdio"
				: hasUrl
					? "http"
					: "unknown";

			const hasHeaders = isRecord(rawConfig.headers);
			const hasOAuth = isRecord(rawConfig.oauth);

			const server: McpServerConfig = {
				name,
				transport,
				sourcePath: configPath,
				sourceKey: serverGroup.key,
				...(hasCommand && { command: rawConfig.command as string }),
				...(hasCommand && { args: sanitizeArgs(rawConfig.args) }),
				...(hasCommand && { env: sanitizeEnv(rawConfig.env) }),
				...(typeof rawConfig.cwd === "string" && { cwd: rawConfig.cwd }),
				...(hasUrl && { url: rawConfig.url as string }),
				...(hasHeaders && { headers: rawConfig.headers as Record<string, string> }),
				...(hasOAuth && { oauth: rawConfig.oauth as McpHttpAuthConfig["oauth"] }),
			};

			const winner = seen.get(name);
			if (winner) {
				shadowed.push({ name, path: configPath, winnerPath: winner.sourcePath });
				continue;
			}

			seen.set(name, server);
			servers.push(server);
		}
	}

	configCache = {
		baseDir: resolvedBaseDir,
		checkedPaths,
		servers,
		issues,
		shadowed,
	};
	return configCache;
}

function getToolCache(name: string, baseDir: string = process.cwd()): McpToolSchema[] | undefined {
	return toolCache.get(cacheKey(baseDir, name));
}

function setToolCache(name: string, tools: McpToolSchema[], baseDir: string = process.cwd()): void {
	toolCache.set(cacheKey(baseDir, name), tools);
}

export function getMcpConfigSnapshot(options?: { refresh?: boolean; baseDir?: string }): McpConfigSnapshot {
	if (options?.refresh) configCache = null;
	return readConfigSnapshot(options?.baseDir);
}

export function listConfiguredMcpServers(options?: { refresh?: boolean; baseDir?: string }): McpServerConfig[] {
	return getMcpConfigSnapshot(options).servers;
}

export function getMcpServerConfig(name: string, options?: { refresh?: boolean; baseDir?: string }): McpServerConfig | undefined {
	const normalized = name.trim().toLowerCase();
	return getMcpConfigSnapshot(options).servers.find((server) => server.name.toLowerCase() === normalized);
}

/** @internal Alias used by connection cache — always keys by canonical config.name. */
async function getOrConnect(name: string, signal?: AbortSignal, options?: { refresh?: boolean; baseDir?: string; timeoutMs?: number }): Promise<Client> {
	const config = getMcpServerConfig(name, options);
	if (!config) throw new Error(`Unknown MCP server: "${name}". Use mcp_servers to list available servers.`);
	const baseDir = resolveBaseDir(options?.baseDir);
	const key = cacheKey(baseDir, config.name);
	if (options?.refresh) await closeConnectionByKey(key);
	const existing = connections.get(config.name);
	if (existing) return existing.client;
	const transport = createTransport(config);
	const client = createClient();
	await client.connect(transport, { signal, timeout: options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS });
	connections.set(config.name, { client, transport });
	return client;
}

export function getCachedMcpTools(name: string, baseDir: string = process.cwd()): McpToolSchema[] | undefined {
	return getToolCache(name, baseDir);
}

export function isMcpServerConnected(name: string, baseDir: string = process.cwd()): boolean {
	return connections.has(cacheKey(baseDir, name));
}

async function closeConnectionByKey(key: string): Promise<void> {
	const existing = connections.get(key);
	if (!existing) return;
	try {
		await existing.client.close();
	} catch {
		// Best-effort cleanup.
	} finally {
		connections.delete(key);
		toolCache.delete(key);
	}
}

export async function closeMcpConnection(name: string, baseDir: string = process.cwd()): Promise<void> {
	await closeConnectionByKey(cacheKey(baseDir, name));
}

export async function closeAllMcpConnections(): Promise<void> {
	const keys = Array.from(connections.keys());
	await Promise.allSettled(keys.map((key) => closeConnectionByKey(key)));
	toolCache.clear();
}

export async function invalidateMcpState(options?: { closeConnections?: boolean }): Promise<void> {
	configCache = null;
	if (options?.closeConnections) {
		await closeAllMcpConnections();
		return;
	}
	toolCache.clear();
}

function createClient(): Client {
	return new Client({ name: "gsd", version: "1.0.0" });
}

function createTransport(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
	if (config.transport === "stdio" && config.command) {
		return new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
			cwd: config.cwd,
			stderr: "pipe",
		});
	}
	if (config.transport === "http" && config.url) {
		const resolvedUrl = config.url.replace(
			/\$\{([^}]+)\}/g,
			(_, varName) => process.env[varName] ?? "",
		);
		const httpOpts = buildHttpTransportOpts({
			headers: config.headers,
			oauth: config.oauth,
		});
		return new StreamableHTTPClientTransport(new URL(resolvedUrl), httpOpts);
	}
	throw new Error(`Server "${config.name}" has unsupported transport: ${config.transport}`);
}

export async function getOrConnectMcpServer(
	name: string,
	signal?: AbortSignal,
	options?: { refresh?: boolean; baseDir?: string; timeoutMs?: number },
): Promise<Client> {
	const baseDir = resolveBaseDir(options?.baseDir);
	const key = cacheKey(baseDir, name);
	if (options?.refresh) await closeConnectionByKey(key);

	const existing = connections.get(key);
	if (existing) return existing.client;

	const config = getMcpServerConfig(name, { baseDir });
	if (!config) {
		throw new Error(`Unknown MCP server: "${name}". Use mcp_servers to list available servers.`);
	}

	const client = createClient();
	const transport = createTransport(config);
	await client.connect(transport, { signal, timeout: options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS });
	connections.set(key, { client, transport });
	return client;
}

export async function discoverMcpServerTools(
	name: string,
	options?: DiscoverOptions,
): Promise<{ tools: McpToolSchema[]; cached: boolean }> {
	const baseDir = resolveBaseDir(options?.baseDir);
	const useCache = options?.useCache ?? true;
	const cached = useCache ? getToolCache(name, baseDir) : undefined;
	if (cached) return { tools: cached, cached: true };

	const client = await getOrConnectMcpServer(name, options?.signal, {
		baseDir,
		timeoutMs: options?.timeoutMs,
	});
	const result = await client.listTools(undefined, {
		signal: options?.signal,
		timeout: options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
	});
	const tools: McpToolSchema[] = (result.tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
	}));
	setToolCache(name, tools, baseDir);
	return { tools, cached: false };
}

function relativePath(filePath: string, baseDir: string): string {
	const rel = relative(baseDir, filePath);
	return rel && !rel.startsWith("..") ? rel : filePath;
}

export function formatMcpSourcePath(filePath: string, baseDir: string = process.cwd()): string {
	return relativePath(filePath, resolveBaseDir(baseDir));
}

function compactSegment(value: string): string {
	if (value.includes("/") || value.includes("\\")) return basename(value);
	return value;
}

export function formatMcpTarget(
	server: McpServerConfig,
	options?: { verbose?: boolean },
): string {
	const verbose = options?.verbose ?? false;
	if (server.transport === "http" && server.url) {
		if (verbose) return server.url;
		try {
			return new URL(server.url).host || server.url;
		} catch {
			return server.url;
		}
	}
	if (server.transport === "stdio" && server.command) {
		const command = verbose ? server.command : compactSegment(server.command);
		const args = (server.args ?? []).slice(0, 2).map((arg) => (verbose ? arg : compactSegment(arg)));
		const preview = [command, ...args].join(" ").trim();
		return preview || command;
	}
	return "invalid config";
}

function collectErrorMessages(error: unknown): string[] {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	let depth = 0;
	while (current && depth < 8 && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			messages.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
			depth += 1;
			continue;
		}
		messages.push(String(current));
		break;
	}
	return messages.filter(Boolean);
}

function classifyDiagnosticError(server: McpServerConfig, error: unknown): { summary: string; detail: string } {
	const messages = collectErrorMessages(error);
	const detail = messages.join("\nCaused by: ") || "Unknown MCP error";
	const lower = detail.toLowerCase();

	if (server.transport === "stdio" && (lower.includes("enoent") || lower.includes("not found"))) {
		return { summary: "NOT FOUND on PATH", detail };
	}
	if (lower.includes("econnrefused") || lower.includes("connection refused")) {
		return { summary: "connection refused", detail };
	}
	if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("aborted")) {
		return { summary: "timeout", detail };
	}
	if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
		return { summary: "authentication failed", detail };
	}
	if (lower.includes("unsupported transport")) {
		return { summary: "invalid config", detail };
	}
	if (lower.includes("fetch failed")) {
		return { summary: "network error", detail };
	}
	return { summary: messages[0] ?? "MCP error", detail };
}

async function diagnoseServer(
	server: McpServerConfig,
	options: Required<Pick<DiagnosticOptions, "baseDir" | "timeoutMs" | "verbose">>,
): Promise<McpServerDiagnostic> {
	const start = Date.now();

	if (server.transport === "unknown") {
		return {
			server,
			status: "error",
			summary: "invalid config",
			detail: `Server "${server.name}" must define either \`command\` or \`url\`.`,
			durationMs: Date.now() - start,
		};
	}

	try {
		const signal = AbortSignal.timeout(options.timeoutMs);
		const { tools } = await discoverMcpServerTools(server.name, {
			baseDir: options.baseDir,
			signal,
			timeoutMs: options.timeoutMs,
			useCache: false,
		});
		return {
			server,
			status: "ok",
			summary: `${tools.length} tool${tools.length === 1 ? "" : "s"}`,
			toolCount: tools.length,
			tools: options.verbose ? tools : undefined,
			durationMs: Date.now() - start,
		};
	} catch (error: unknown) {
		const classified = classifyDiagnosticError(server, error);
		return {
			server,
			status: "error",
			summary: classified.summary,
			detail: classified.detail,
			durationMs: Date.now() - start,
		};
	}
}

export async function runMcpDiagnostics(options?: DiagnosticOptions): Promise<McpDiagnosticReport> {
	const baseDir = resolveBaseDir(options?.baseDir);
	if (options?.refresh) {
		await invalidateMcpState({ closeConnections: true });
	}
	const config = getMcpConfigSnapshot({ refresh: options?.refresh, baseDir });
	const requestedServer = options?.server?.trim() || undefined;
	const candidateServers = requestedServer
		? config.servers.filter((server) => server.name === requestedServer)
		: config.servers;
	const diagnostics = await Promise.all(
		candidateServers.map((server) => diagnoseServer(server, {
			baseDir,
			timeoutMs: options?.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
			verbose: options?.verbose ?? false,
		})),
	);
	return {
		baseDir,
		requestedServer,
		requestedServerFound: requestedServer ? candidateServers.length > 0 : true,
		config,
		servers: diagnostics.sort((a, b) => a.server.name.localeCompare(b.server.name)),
		summary: {
			total: diagnostics.length,
			ok: diagnostics.filter((server) => server.status === "ok").length,
			error: diagnostics.filter((server) => server.status === "error").length,
		},
	};
}

function pad(value: string, width: number): string {
	return value.padEnd(width);
}

export function formatMcpDiagnosticsReport(
	report: McpDiagnosticReport,
	options?: { verbose?: boolean },
): string {
	const verbose = options?.verbose ?? false;
	const lines: string[] = ["MCP servers"];
	const baseDir = report.baseDir;

	if (report.requestedServer && !report.requestedServerFound) {
		lines.push("", `No configured MCP server named \"${report.requestedServer}\".`);
	}

	if (report.servers.length === 0 && report.config.issues.length === 0 && !report.requestedServer) {
		lines.push(
			"",
			"No MCP servers configured.",
			`Checked: ${report.config.checkedPaths.map((path) => formatMcpSourcePath(path, baseDir)).join(", ")}`,
		);
		return lines.join("\n");
	}

	if (report.servers.length > 0) {
		lines.push("");
		const rows = report.servers.map((entry) => ({
			icon: entry.status === "ok" ? "✓" : "✗",
			name: entry.server.name,
			transport: entry.server.transport,
			source: formatMcpSourcePath(entry.server.sourcePath, baseDir),
			target: formatMcpTarget(entry.server),
			result: entry.status === "ok"
				? `${entry.toolCount ?? 0} tool${entry.toolCount === 1 ? "" : "s"}`
				: entry.summary,
		}));
		const widths = {
			name: Math.max(...rows.map((row) => row.name.length), 4),
			transport: Math.max(...rows.map((row) => row.transport.length), 4),
			source: Math.max(...rows.map((row) => row.source.length), 6),
			target: Math.max(...rows.map((row) => row.target.length), 6),
		};
		for (const row of rows) {
			lines.push(
				`${row.icon} ${pad(row.name, widths.name)}  ${pad(row.transport, widths.transport)}  ${pad(row.source, widths.source)}  ${pad(row.target, widths.target)}  ${row.result}`,
			);
		}
	}

	if (report.config.issues.length > 0) {
		lines.push("", "Config issues");
		for (const issue of report.config.issues) {
			lines.push(`  ${issue.severity === "error" ? "✗" : "!"} ${formatMcpSourcePath(issue.path, baseDir)} — ${issue.message}`);
			if (verbose && issue.detail) lines.push(`    ${issue.detail}`);
		}
	}

	if (report.config.shadowed.length > 0) {
		lines.push("", "Shadowed definitions");
		for (const shadow of report.config.shadowed) {
			lines.push(
				`  • ${shadow.name} in ${formatMcpSourcePath(shadow.path, baseDir)} ignored — ${formatMcpSourcePath(shadow.winnerPath, baseDir)} wins`,
			);
		}
	}

	if (verbose && report.servers.length > 0) {
		for (const entry of report.servers) {
			lines.push("", `## ${entry.server.name}`);
			lines.push(`transport: ${entry.server.transport}`);
			lines.push(`source: ${formatMcpSourcePath(entry.server.sourcePath, baseDir)} (${entry.server.sourceKey})`);
			if (entry.server.transport === "stdio") {
				lines.push(`command: ${formatMcpTarget(entry.server, { verbose: true })}`);
				if (entry.server.cwd) lines.push(`cwd: ${entry.server.cwd}`);
			}
			if (entry.server.transport === "http" && entry.server.url) {
				lines.push(`url: ${entry.server.url}`);
			}
			lines.push(`status: ${entry.status === "ok" ? "ok" : "error"}`);
			lines.push(`time: ${entry.durationMs}ms`);
			if (entry.status === "ok") {
				lines.push(`tools: ${entry.toolCount ?? 0}`);
				if (entry.tools && entry.tools.length > 0) {
					lines.push(...entry.tools.map((tool) => `  - ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`));
				}
			} else if (entry.detail) {
				lines.push(`error: ${entry.detail}`);
			}
		}
	}

	if (report.config.checkedPaths.length > 0) {
		lines.push("", `Checked: ${report.config.checkedPaths.map((path) => formatMcpSourcePath(path, baseDir)).join(", ")}`);
	}

	return lines.join("\n");
}
