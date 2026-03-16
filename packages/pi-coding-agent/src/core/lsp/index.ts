import * as fs from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@gsd/pi-agent-core";
import {
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	refreshFile,
	sendRequest,
	setIdleTimeout,
	WARMUP_TIMEOUT_MS,
} from "./client.js";
import { getServersForFile, type LspConfig, loadConfig } from "./config.js";
import { applyTextEdits, applyWorkspaceEdit } from "./edits.js";
import { ToolAbortError, clampTimeout, throwIfAborted } from "./helpers.js";
import { detectLspmux } from "./lspmux.js";
import {
	type CallHierarchyIncomingCall,
	type CallHierarchyItem,
	type CallHierarchyOutgoingCall,
	type CodeAction,
	type CodeActionContext,
	type Command,
	type Diagnostic,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type LspClient,
	type LspParams,
	type LspToolDetails,
	lspSchema,
	type ServerConfig,
	type SignatureHelp,
	type SymbolInformation,
	type TextEdit,
	type WorkspaceEdit,
} from "./types.js";
import {
	applyCodeAction,
	collectGlobMatches,
	dedupeWorkspaceSymbols,
	extractHoverText,
	fileToUri,
	filterWorkspaceSymbols,
	formatCallHierarchyItem,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatGroupedDiagnosticMessages,
	formatLocation,
	formatSignatureHelp,
	formatSymbolInformation,
	formatWorkspaceEdit,
	hasGlobPattern,
	readLocationContext,
	resolveSymbolColumn,
	sortDiagnostics,
	symbolKindToIcon,
	uriToFile,
} from "./utils.js";

export type { LspServerStatus } from "./client.js";
export type { LspToolDetails } from "./types.js";
export { lspSchema } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lspDescription = fsSync.readFileSync(path.join(__dirname, "lsp.md"), "utf-8");

// =============================================================================
// Warmup API
// =============================================================================

export interface LspWarmupResult {
	servers: Array<{
		name: string;
		status: "ready" | "error";
		fileTypes: string[];
		error?: string;
	}>;
}

export async function warmupLspServers(cwd: string): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: result.reason?.message ?? String(result.reason),
			});
		}
	}

	return { servers };
}

export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

// =============================================================================
// Internal Helpers
// =============================================================================

const configCache = new Map<string, LspConfig>();

function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return Object.entries(config.servers) as Array<[string, ServerConfig]>;
}

function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath);
}

function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const WORKSPACE_SYMBOL_LIMIT = 200;

function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

const LOCATION_CONTEXT_LINES = 1;
const REFERENCE_CONTEXT_LIMIT = 50;

function normalizeLocationResult(result: Location | Location[] | LocationLink | LocationLink[] | null): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap(loc => {
		if ("uri" in loc) {
			return [loc as Location];
		}
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}

async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const context = await readLocationContext(
		uriToFile(location.uri),
		location.range.start.line + 1,
		LOCATION_CONTEXT_LINES,
	);
	if (context.length === 0) {
		return header;
	}
	return `${header}\n${context.map(lineText => `    ${lineText}`).join("\n")}`;
}

async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	let output = `Restarted ${serverName}`;
	const reloadMethods = ["rust-analyzer/reloadWorkspace", "workspace/didChangeConfiguration"];
	for (const method of reloadMethods) {
		try {
			await sendRequest(client, method, method.includes("Configuration") ? { settings: {} } : null, signal);
			output = `Reloaded ${serverName}`;
			break;
		} catch {
			// Method not supported, try next
		}
	}
	if (output.startsWith("Restarted")) {
		client.proc.kill();
	}
	return output;
}

async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	timeoutMs = 3000,
	signal?: AbortSignal,
	minVersion?: number,
): Promise<Diagnostic[]> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const diagnostics = client.diagnostics.get(uri);
		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		if (diagnostics !== undefined && versionOk) return diagnostics;
		await new Promise<void>(resolve => setTimeout(resolve, 100));
	}
	return client.diagnostics.get(uri) ?? [];
}

// =============================================================================
// Workspace Diagnostics
// =============================================================================

interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

function detectProjectType(cwd: string): ProjectType {
	if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	}
	if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	}
	if (fs.existsSync(path.join(cwd, "go.mod"))) {
		return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	}
	if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pyrightconfig.json"))) {
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	}
	return { type: "unknown", description: "Unknown project type" };
}

async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = detectProjectType(cwd);
	if (!projectType.command) {
		return {
			output: "Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)",
			projectType,
		};
	}
	const [cmd, ...cmdArgs] = projectType.command;
	const proc = spawn(cmd, cmdArgs, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const abortHandler = () => {
		proc.kill();
	};
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		const exitCode = await new Promise<number>((resolve) => {
			proc.on("exit", (code: number | null) => resolve(code ?? 1));
		});

		const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
		const stderr = Buffer.concat(stderrChunks).toString("utf-8");

		throwIfAborted(signal);
		const combined = (stdout + stderr).trim();
		if (!combined) {
			return { output: "No issues found", projectType };
		}
		const lines = combined.split("\n");
		if (lines.length > 50) {
			return { output: `${lines.slice(0, 50).join("\n")}\n... and ${lines.length - 50} more lines`, projectType };
		}
		return { output: combined, projectType };
	} catch (e: unknown) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}

// =============================================================================
// Path Resolution
// =============================================================================

function resolveToCwd(file: string, cwd: string): string {
	return path.resolve(cwd, file);
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Create an LSP tool configured for a specific working directory.
 */
export function createLspTool(cwd: string): AgentTool<typeof lspSchema, LspToolDetails> {
	return {
		name: "lsp",
		label: "LSP",
		description: lspDescription,
		parameters: lspSchema,

		async execute(
			_toolCallId: string,
			params: LspParams,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
		): Promise<AgentToolResult<LspToolDetails>> {
			const { action, file, line, symbol, occurrence, query, new_name, apply, tab_size, insert_spaces, timeout } = params;
			const timeoutSec = clampTimeout(timeout);
			const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
			signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			throwIfAborted(signal);

			const config = getConfig(cwd);

			// Status action doesn't need a file
			if (action === "status") {
				const servers = Object.keys(config.servers);
				const lspmuxState = await detectLspmux();
				const lspmuxStatus = lspmuxState.available
					? lspmuxState.running
						? "lspmux: active (multiplexing enabled)"
						: "lspmux: installed but server not running"
					: "";

				const serverStatus =
					servers.length > 0
						? `Active language servers: ${servers.join(", ")}`
						: "No language servers configured for this project";

				const output = lspmuxStatus ? `${serverStatus}\n${lspmuxStatus}` : serverStatus;
				return {
					content: [{ type: "text", text: output }],
					details: { action, success: true, request: params },
				};
			}

			// Diagnostics can be batch or single-file
			if (action === "diagnostics") {
				if (!file) {
					const result = await runWorkspaceDiagnostics(cwd, signal);
					return {
						content: [
							{
								type: "text",
								text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
							},
						],
						details: { action, success: true, request: params },
					};
				}

				let targets: string[];
				let truncatedGlobTargets = false;
				if (hasGlobPattern(file)) {
					const globMatches = await collectGlobMatches(file, cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
					targets = globMatches.matches;
					truncatedGlobTargets = globMatches.truncated;
				} else {
					targets = [file];
				}

				if (targets.length === 0) {
					return {
						content: [{ type: "text", text: `No files matched pattern: ${file}` }],
						details: { action, success: true, request: params },
					};
				}

				const detailed = targets.length > 1 || truncatedGlobTargets;
				const diagnosticsWaitTimeoutMs = detailed
					? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
					: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
				const results: string[] = [];
				const allServerNames = new Set<string>();
				if (truncatedGlobTargets) {
					results.push(
						`[W] Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
					);
				}

				for (const target of targets) {
					throwIfAborted(signal);
					const resolved = resolveToCwd(target, cwd);
					const servers = getServersForFile(config, resolved);
					if (servers.length === 0) {
						results.push(`[E] ${target}: No language server found`);
						continue;
					}

					const uri = fileToUri(resolved);
					const relPath = path.relative(cwd, resolved);
					const allDiagnostics: Diagnostic[] = [];

					for (const [serverName, serverConfig] of servers) {
						allServerNames.add(serverName);
						try {
							throwIfAborted(signal);
							const client = await getOrCreateClient(serverConfig, cwd);
							const minVersion = client.diagnosticsVersion;
							await refreshFile(client, resolved, signal);
							const diagnostics = await waitForDiagnostics(
								client,
								uri,
								diagnosticsWaitTimeoutMs,
								signal,
								minVersion,
							);
							allDiagnostics.push(...diagnostics);
						} catch (err: unknown) {
							if (err instanceof ToolAbortError || signal?.aborted) {
								throw err;
							}
						}
					}

					// Deduplicate
					const seen = new Set<string>();
					const uniqueDiagnostics: Diagnostic[] = [];
					for (const d of allDiagnostics) {
						const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
						if (!seen.has(key)) {
							seen.add(key);
							uniqueDiagnostics.push(d);
						}
					}

					sortDiagnostics(uniqueDiagnostics);

					if (!detailed && targets.length === 1) {
						if (uniqueDiagnostics.length === 0) {
							return {
								content: [{ type: "text", text: "No diagnostics" }],
								details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
							};
						}

						const summary = formatDiagnosticsSummary(uniqueDiagnostics);
						const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
						const output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`;
						return {
							content: [{ type: "text", text: output }],
							details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
						};
					}

					if (uniqueDiagnostics.length === 0) {
						results.push(`OK ${relPath}: no issues`);
					} else {
						const summary = formatDiagnosticsSummary(uniqueDiagnostics);
						results.push(`[E] ${relPath}: ${summary}`);
						const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
						results.push(formatGroupedDiagnosticMessages(formatted));
					}
				}

				return {
					content: [{ type: "text", text: results.join("\n") }],
					details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
				};
			}

			const requiresFile = !file && action !== "symbols" && action !== "reload";

			if (requiresFile) {
				return {
					content: [{ type: "text", text: "Error: file parameter required for this action" }],
					details: { action, success: false },
				};
			}

			const resolvedFile = file ? resolveToCwd(file, cwd) : null;

			// Workspace symbol search (no file)
			if (action === "symbols" && !resolvedFile) {
				const normalizedQuery = query?.trim();
				if (!normalizedQuery) {
					return {
						content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
						details: { action, success: false, request: params },
					};
				}
				const servers = getLspServers(config);
				if (servers.length === 0) {
					return {
						content: [{ type: "text", text: "No language server found for this action" }],
						details: { action, success: false, request: params },
					};
				}
				const aggregatedSymbols: SymbolInformation[] = [];
				const respondingServers = new Set<string>();
				for (const [workspaceServerName, workspaceServerConfig] of servers) {
					throwIfAborted(signal);
					try {
						const workspaceClient = await getOrCreateClient(workspaceServerConfig, cwd);
						const workspaceResult = (await sendRequest(
							workspaceClient,
							"workspace/symbol",
							{ query: normalizedQuery },
							signal,
						)) as SymbolInformation[] | null;
						if (!workspaceResult || workspaceResult.length === 0) {
							continue;
						}
						respondingServers.add(workspaceServerName);
						aggregatedSymbols.push(...filterWorkspaceSymbols(workspaceResult, normalizedQuery));
					} catch (err: unknown) {
						if (err instanceof ToolAbortError || signal?.aborted) {
							throw err;
						}
					}
				}
				const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols);
				if (dedupedSymbols.length === 0) {
					return {
						content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
						details: {
							action,
							serverName: Array.from(respondingServers).join(", "),
							success: true,
							request: params,
						},
					};
				}
				const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
				const lines = limitedSymbols.map(s => formatSymbolInformation(s, cwd));
				const truncationLine =
					dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
						? `\n... ${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map(l => `  ${l}`).join("\n")}${truncationLine}`,
						},
					],
					details: {
						action,
						serverName: Array.from(respondingServers).join(", "),
						success: true,
						request: params,
					},
				};
			}

			// Reload all servers (no file)
			if (action === "reload" && !resolvedFile) {
				const servers = getLspServers(config);
				if (servers.length === 0) {
					return {
						content: [{ type: "text", text: "No language server found for this action" }],
						details: { action, success: false, request: params },
					};
				}
				const outputs: string[] = [];
				for (const [workspaceServerName, workspaceServerConfig] of servers) {
					throwIfAborted(signal);
					try {
						const workspaceClient = await getOrCreateClient(workspaceServerConfig, cwd);
						outputs.push(await reloadServer(workspaceClient, workspaceServerName, signal));
					} catch (err: unknown) {
						if (err instanceof ToolAbortError || signal?.aborted) {
							throw err;
						}
						const errorMessage = err instanceof Error ? err.message : String(err);
						outputs.push(`Failed to reload ${workspaceServerName}: ${errorMessage}`);
					}
				}
				return {
					content: [{ type: "text", text: outputs.join("\n") }],
					details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params },
				};
			}

			// File-specific actions
			const serverInfo = resolvedFile ? getLspServerForFile(config, resolvedFile) : null;
			if (!serverInfo) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false },
				};
			}

			const [serverName, serverConfig] = serverInfo;

			try {
				const client = await getOrCreateClient(serverConfig, cwd);
				const targetFile = resolvedFile;

				if (targetFile) {
					await ensureFileOpen(client, targetFile, signal);
				}

				const uri = targetFile ? fileToUri(targetFile) : "";
				const resolvedLine = line ?? 1;
				const resolvedCharacter = targetFile
					? await resolveSymbolColumn(targetFile, resolvedLine, symbol, occurrence)
					: 0;
				const position = { line: resolvedLine - 1, character: resolvedCharacter };

				let output: string;

				switch (action) {
					case "definition": {
						const result = (await sendRequest(
							client,
							"textDocument/definition",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as Location | Location[] | LocationLink | LocationLink[] | null;

						const locations = normalizeLocationResult(result);

						if (locations.length === 0) {
							output = "No definition found";
						} else {
							const lines = await Promise.all(
								locations.map(location => formatLocationWithContext(location, cwd)),
							);
							output = `Found ${locations.length} definition(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "type_definition": {
						const result = (await sendRequest(
							client,
							"textDocument/typeDefinition",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as Location | Location[] | LocationLink | LocationLink[] | null;

						const locations = normalizeLocationResult(result);

						if (locations.length === 0) {
							output = "No type definition found";
						} else {
							const lines = await Promise.all(
								locations.map(location => formatLocationWithContext(location, cwd)),
							);
							output = `Found ${locations.length} type definition(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "implementation": {
						const result = (await sendRequest(
							client,
							"textDocument/implementation",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as Location | Location[] | LocationLink | LocationLink[] | null;

						const locations = normalizeLocationResult(result);

						if (locations.length === 0) {
							output = "No implementation found";
						} else {
							const lines = await Promise.all(
								locations.map(location => formatLocationWithContext(location, cwd)),
							);
							output = `Found ${locations.length} implementation(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "references": {
						const result = (await sendRequest(
							client,
							"textDocument/references",
							{
								textDocument: { uri },
								position,
								context: { includeDeclaration: true },
							},
							signal,
						)) as Location[] | null;

						if (!result || result.length === 0) {
							output = "No references found";
						} else {
							const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT);
							const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT);
							const contextualLines = await Promise.all(
								contextualReferences.map(location => formatLocationWithContext(location, cwd)),
							);
							const plainLines = plainReferences.map(location => `  ${formatLocation(location, cwd)}`);
							const lines = plainLines.length
								? [
										...contextualLines,
										`  ... ${plainLines.length} additional reference(s) shown without context`,
										...plainLines,
									]
								: contextualLines;
							output = `Found ${result.length} reference(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "hover": {
						const result = (await sendRequest(
							client,
							"textDocument/hover",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as Hover | null;

						if (!result || !result.contents) {
							output = "No hover information";
						} else {
							output = extractHoverText(result.contents);
						}
						break;
					}

					case "code_actions": {
						const diagnostics = client.diagnostics.get(uri) ?? [];
						const context: CodeActionContext = {
							diagnostics,
							only: !apply && query ? [query] : undefined,
							triggerKind: 1,
						};

						const result = (await sendRequest(
							client,
							"textDocument/codeAction",
							{
								textDocument: { uri },
								range: { start: position, end: position },
								context,
							},
							signal,
						)) as (CodeAction | Command)[] | null;

						if (!result || result.length === 0) {
							output = "No code actions available";
							break;
						}

						if (apply === true && query) {
							const normalizedQuery = query.trim();
							if (normalizedQuery.length === 0) {
								output = "Error: query parameter required when apply=true for code_actions";
								break;
							}
							const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
							const selectedAction = result.find(
								(actionItem, index) =>
									(parsedIndex !== null && index === parsedIndex) ||
									actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
							);

							if (!selectedAction) {
								const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
								output = `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`;
								break;
							}

							const appliedAction = await applyCodeAction(selectedAction, {
								resolveCodeAction: async (actionItem: CodeAction) =>
									(await sendRequest(client, "codeAction/resolve", actionItem, signal)) as CodeAction,
								applyWorkspaceEdit: async (edit: WorkspaceEdit) => applyWorkspaceEdit(edit, cwd),
								executeCommand: async (commandItem: Command) => {
									await sendRequest(
										client,
										"workspace/executeCommand",
										{
											command: commandItem.command,
											arguments: commandItem.arguments ?? [],
										},
										signal,
									);
								},
							});

							if (!appliedAction) {
								output = `Action "${selectedAction.title}" has no workspace edit or command to apply`;
								break;
							}

							const summaryLines: string[] = [];
							if (appliedAction.edits.length > 0) {
								summaryLines.push("  Workspace edit:");
								summaryLines.push(...appliedAction.edits.map(item => `    ${item}`));
							}
							if (appliedAction.executedCommands.length > 0) {
								summaryLines.push("  Executed command(s):");
								summaryLines.push(...appliedAction.executedCommands.map(commandName => `    ${commandName}`));
							}

							output = `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`;
							break;
						}

						const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
						output = `${result.length} code action(s):\n${actionLines.join("\n")}`;
						break;
					}

					case "symbols": {
						if (!targetFile) {
							output = "Error: file parameter required for document symbols";
							break;
						}
						const result = (await sendRequest(
							client,
							"textDocument/documentSymbol",
							{
								textDocument: { uri },
							},
							signal,
						)) as (DocumentSymbol | SymbolInformation)[] | null;

						if (!result || result.length === 0) {
							output = "No symbols found";
						} else {
							const relPath = path.relative(cwd, targetFile);
							if ("selectionRange" in result[0]) {
								const lines = (result as DocumentSymbol[]).flatMap(s => formatDocumentSymbol(s));
								output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
							} else {
								const lines = (result as SymbolInformation[]).map(s => {
									const line = s.location.range.start.line + 1;
									const icon = symbolKindToIcon(s.kind);
									return `${icon} ${s.name} @ line ${line}`;
								});
								output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
							}
						}
						break;
					}

					case "incoming_calls": {
						const prepareResult = (await sendRequest(
							client,
							"textDocument/prepareCallHierarchy",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as CallHierarchyItem[] | null;

						if (!prepareResult || prepareResult.length === 0) {
							output = "No call hierarchy item found at this position";
							break;
						}

						const incomingResult = (await sendRequest(
							client,
							"callHierarchy/incomingCalls",
							{ item: prepareResult[0] },
							signal,
						)) as CallHierarchyIncomingCall[] | null;

						if (!incomingResult || incomingResult.length === 0) {
							output = `No incoming calls found for ${prepareResult[0].name}`;
							break;
						}

						const incomingLines: string[] = [];
						const limitedIncoming = incomingResult.slice(0, REFERENCE_CONTEXT_LIMIT);
						for (const call of limitedIncoming) {
							const header = formatCallHierarchyItem(call.from, cwd);
							const filePath = uriToFile(call.from.uri);
							const callLine = call.fromRanges[0]?.start.line ?? call.from.selectionRange.start.line;
							const context = await readLocationContext(filePath, callLine + 1, LOCATION_CONTEXT_LINES);
							if (context.length > 0) {
								incomingLines.push(`  ${header}\n${context.map(l => `    ${l}`).join("\n")}`);
							} else {
								incomingLines.push(`  ${header}`);
							}
						}

						const truncation = incomingResult.length > REFERENCE_CONTEXT_LIMIT
							? `\n  ... ${incomingResult.length - REFERENCE_CONTEXT_LIMIT} additional caller(s) omitted`
							: "";
						output = `${incomingResult.length} caller(s) of ${prepareResult[0].name}:\n${incomingLines.join("\n")}${truncation}`;
						break;
					}

					case "outgoing_calls": {
						const prepareResult = (await sendRequest(
							client,
							"textDocument/prepareCallHierarchy",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as CallHierarchyItem[] | null;

						if (!prepareResult || prepareResult.length === 0) {
							output = "No call hierarchy item found at this position";
							break;
						}

						const outgoingResult = (await sendRequest(
							client,
							"callHierarchy/outgoingCalls",
							{ item: prepareResult[0] },
							signal,
						)) as CallHierarchyOutgoingCall[] | null;

						if (!outgoingResult || outgoingResult.length === 0) {
							output = `No outgoing calls found from ${prepareResult[0].name}`;
							break;
						}

						const outgoingLines: string[] = [];
						const limitedOutgoing = outgoingResult.slice(0, REFERENCE_CONTEXT_LIMIT);
						for (const call of limitedOutgoing) {
							const header = formatCallHierarchyItem(call.to, cwd);
							const filePath = uriToFile(call.to.uri);
							const callLine = call.to.selectionRange.start.line;
							const context = await readLocationContext(filePath, callLine + 1, LOCATION_CONTEXT_LINES);
							if (context.length > 0) {
								outgoingLines.push(`  ${header}\n${context.map(l => `    ${l}`).join("\n")}`);
							} else {
								outgoingLines.push(`  ${header}`);
							}
						}

						const outTruncation = outgoingResult.length > REFERENCE_CONTEXT_LIMIT
							? `\n  ... ${outgoingResult.length - REFERENCE_CONTEXT_LIMIT} additional callee(s) omitted`
							: "";
						output = `${outgoingResult.length} callee(s) from ${prepareResult[0].name}:\n${outgoingLines.join("\n")}${outTruncation}`;
						break;
					}

					case "format": {
						if (!targetFile) {
							output = "Error: file parameter required for format";
							break;
						}

						const formatResult = (await sendRequest(
							client,
							"textDocument/formatting",
							{
								textDocument: { uri },
								options: {
									tabSize: tab_size ?? 4,
									insertSpaces: insert_spaces ?? true,
								},
							},
							signal,
						)) as TextEdit[] | null;

						if (!formatResult || formatResult.length === 0) {
							const relPath = path.relative(cwd, targetFile);
							output = `${relPath}: already formatted (no changes)`;
							break;
						}

						await applyTextEdits(targetFile, formatResult);
						const relPath = path.relative(cwd, targetFile);
						output = `Formatted ${relPath}: ${formatResult.length} edit(s) applied`;
						break;
					}

					case "signature": {
						const sigResult = (await sendRequest(
							client,
							"textDocument/signatureHelp",
							{
								textDocument: { uri },
								position,
							},
							signal,
						)) as SignatureHelp | null;

						if (!sigResult || !sigResult.signatures || sigResult.signatures.length === 0) {
							output = "No signature information at this position";
						} else {
							output = formatSignatureHelp(sigResult);
						}
						break;
					}

					case "rename": {
						if (!new_name) {
							return {
								content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
								details: { action, serverName, success: false },
							};
						}

						const result = (await sendRequest(
							client,
							"textDocument/rename",
							{
								textDocument: { uri },
								position,
								newName: new_name,
							},
							signal,
						)) as WorkspaceEdit | null;

						if (!result) {
							output = "Rename returned no edits";
						} else {
							const shouldApply = apply !== false;
							if (shouldApply) {
								const applied = await applyWorkspaceEdit(result, cwd);
								output = `Applied rename:\n${applied.map(a => `  ${a}`).join("\n")}`;
							} else {
								const preview = formatWorkspaceEdit(result, cwd);
								output = `Rename preview:\n${preview.map(p => `  ${p}`).join("\n")}`;
							}
						}
						break;
					}

					case "reload": {
						output = await reloadServer(client, serverName, signal);
						break;
					}

					default:
						output = `Unknown action: ${action}`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: { serverName, action, success: true, request: params },
				};
			} catch (err: unknown) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw new ToolAbortError();
				}
				const errorMessage = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `LSP error: ${errorMessage}` }],
					details: { serverName, action, success: false, request: params },
				};
			}
		},
	};
}

/**
 * Default LSP tool using process.cwd().
 */
export const lspTool = createLspTool(process.cwd());
