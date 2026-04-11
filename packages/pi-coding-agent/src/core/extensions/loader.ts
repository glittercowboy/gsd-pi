/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 * Uses @mariozechner/jiti fork with virtualModules support for compiled Bun binaries.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";
import * as _bundledPiAgentCore from "@gsd/pi-agent-core";
import * as _bundledPiAi from "@gsd/pi-ai";
import * as _bundledPiAiOauth from "@gsd/pi-ai/oauth";
import type { KeyId } from "@gsd/pi-tui";
import * as _bundledPiTui from "@gsd/pi-tui";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "@sinclair/typebox";
import * as _bundledYaml from "yaml";
import * as _bundledMcpClient from "@modelcontextprotocol/sdk/client";
import * as _bundledMcpStdio from "@modelcontextprotocol/sdk/client/stdio.js";
import * as _bundledMcpStreamableHttp from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as _bundledMcpSse from "@modelcontextprotocol/sdk/client/sse.js";
import * as _bundledMcpServer from "@modelcontextprotocol/sdk/server";
import * as _bundledMcpServerStdio from "@modelcontextprotocol/sdk/server/stdio.js";
import * as _bundledMcpServerSse from "@modelcontextprotocol/sdk/server/sse.js";
import * as _bundledMcpServerStreamableHttp from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as _bundledMcpTypes from "@modelcontextprotocol/sdk/types.js";
import { getAgentDir, isBunBinary } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @gsd/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import { getUntrustedExtensionPaths } from "./project-trust.js";
export { isProjectTrusted, trustProject, getUntrustedExtensionPaths } from "./project-trust.js";
import { registerToolCompatibility } from "../tools/tool-compatibility-registry.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	LifecycleHookHandler,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.js";

/**
 * Statically imported modules for Bun binary virtualModules.
 * Maps specifier -> module object for subpaths that must be available in compiled binaries.
 */
const STATIC_BUNDLED_MODULES: Record<string, unknown> = {
	"@sinclair/typebox": _bundledTypebox,
	"@gsd/pi-agent-core": _bundledPiAgentCore,
	"@gsd/pi-tui": _bundledPiTui,
	"@gsd/pi-ai": _bundledPiAi,
	"@gsd/pi-ai/oauth": _bundledPiAiOauth,
	"@gsd/pi-coding-agent": _bundledPiCodingAgent,
	"yaml": _bundledYaml,
	"@modelcontextprotocol/sdk/client": _bundledMcpClient,
	"@modelcontextprotocol/sdk/client/stdio": _bundledMcpStdio,
	"@modelcontextprotocol/sdk/client/stdio.js": _bundledMcpStdio,
	"@modelcontextprotocol/sdk/client/streamableHttp": _bundledMcpStreamableHttp,
	"@modelcontextprotocol/sdk/client/streamableHttp.js": _bundledMcpStreamableHttp,
	"@modelcontextprotocol/sdk/client/sse": _bundledMcpSse,
	"@modelcontextprotocol/sdk/client/sse.js": _bundledMcpSse,
	"@modelcontextprotocol/sdk/server": _bundledMcpServer,
	"@modelcontextprotocol/sdk/server/stdio": _bundledMcpServerStdio,
	"@modelcontextprotocol/sdk/server/stdio.js": _bundledMcpServerStdio,
	"@modelcontextprotocol/sdk/server/sse": _bundledMcpServerSse,
	"@modelcontextprotocol/sdk/server/sse.js": _bundledMcpServerSse,
	"@modelcontextprotocol/sdk/server/streamableHttp": _bundledMcpServerStreamableHttp,
	"@modelcontextprotocol/sdk/server/streamableHttp.js": _bundledMcpServerStreamableHttp,
	"@modelcontextprotocol/sdk/types": _bundledMcpTypes,
	"@modelcontextprotocol/sdk/types.js": _bundledMcpTypes,
	// Aliases for external PI ecosystem packages that import from the original scope
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES: Record<string, unknown> = { ...STATIC_BUNDLED_MODULES };

const require = createRequire(import.meta.url);
const EXTENSION_TIMING_ENABLED = process.env.GSD_STARTUP_TIMING === "1" || process.env.PI_TIMING === "1";

/**
 * Bundled npm packages whose subpath exports should be auto-resolved for extensions.
 * Each package listed here will have its `exports` field read from package.json,
 * and all subpath exports will be registered as jiti aliases (Node.js mode) so that
 * extensions can import any standard subpath without hitting jiti's CJS double-resolve bug.
 */
const BUNDLED_PACKAGES_WITH_EXPORTS = [
	"@modelcontextprotocol/sdk",
	"yaml",
];

/**
 * Read a package's `exports` field and return alias entries mapping
 * specifiers (e.g. `@modelcontextprotocol/sdk/server`) to resolved file paths.
 *
 * Handles:
 * - Explicit subpath exports: `./client` -> `@pkg/client`
 * - Wildcard exports (`./*`): scans the package's dist directory for actual files
 * - Both `.js`-suffixed and bare specifiers for each subpath
 */
function resolveSubpathExports(packageName: string): Record<string, string> {
	const aliases: Record<string, string> = {};

	let packageJsonPath: string;
	try {
		// Resolve the package's root directory via its package.json
		packageJsonPath = require.resolve(`${packageName}/package.json`);
	} catch {
		// Package doesn't allow importing package.json via exports — find it manually
		try {
			const anyEntry = require.resolve(packageName);
			// Walk up from the resolved entry to find package.json
			let dir = path.dirname(anyEntry);
			while (dir !== path.dirname(dir)) {
				const candidate = path.join(dir, "package.json");
				if (fs.existsSync(candidate)) {
					try {
						const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
						if (pkg.name === packageName) {
							packageJsonPath = candidate;
							break;
						}
					} catch {
						// not valid JSON, keep walking
					}
				}
				dir = path.dirname(dir);
			}
		} catch {
			return aliases;
		}
		if (!packageJsonPath!) return aliases;
	}

	let pkg: { exports?: Record<string, unknown> };
	try {
		pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return aliases;
	}

	const exports = pkg.exports;
	if (!exports || typeof exports !== "object") return aliases;

	const packageDir = path.dirname(packageJsonPath);

	for (const [subpath, target] of Object.entries(exports)) {
		if (subpath === ".") continue; // Root export handled by static imports

		// Handle wildcard exports like "./*"
		if (subpath.includes("*")) {
			resolveWildcardExports(packageName, packageDir, subpath, target, aliases);
			continue;
		}

		// Explicit subpath: "./client" -> "@pkg/client"
		const specifier = `${packageName}/${subpath.replace(/^\.\//, "")}`;

		try {
			const resolved = require.resolve(specifier);
			aliases[specifier] = resolved;

			// Add .js-suffixed variant if the specifier doesn't already end in .js
			if (!specifier.endsWith(".js")) {
				const jsSpecifier = `${specifier}.js`;
				try {
					const jsResolved = require.resolve(jsSpecifier);
					aliases[jsSpecifier] = jsResolved;
				} catch {
					// .js variant doesn't resolve — that's fine
				}
			}

			// Add bare variant (without .js) if it ends in .js
			if (specifier.endsWith(".js")) {
				const bareSpecifier = specifier.slice(0, -3);
				try {
					const bareResolved = require.resolve(bareSpecifier);
					aliases[bareSpecifier] = bareResolved;
				} catch {
					// bare variant doesn't resolve — that's fine
				}
			}
		} catch {
			// Subpath doesn't resolve — skip it
		}
	}

	return aliases;
}

/**
 * Resolve wildcard export patterns (e.g. `./*`) by scanning the package's
 * file structure to find all matching files and generate alias entries.
 */
function resolveWildcardExports(
	packageName: string,
	packageDir: string,
	subpathPattern: string,
	target: unknown,
	aliases: Record<string, string>,
): void {
	// Extract the target directory pattern from the export target
	// e.g. { "require": "./dist/cjs/*" } -> "dist/cjs"
	let targetDir: string | null = null;

	if (typeof target === "string") {
		targetDir = target.replace(/\/\*$/, "").replace(/^\.\//, "");
	} else if (target && typeof target === "object") {
		const targetObj = target as Record<string, unknown>;
		// Prefer "require" for CJS compatibility with jiti, fall back to "import"
		const resolved = targetObj.require ?? targetObj.import ?? targetObj.default;
		if (typeof resolved === "string") {
			targetDir = resolved.replace(/\/\*$/, "").replace(/^\.\//, "");
		}
	}

	if (!targetDir) return;

	const fullTargetDir = path.join(packageDir, targetDir);
	if (!fs.existsSync(fullTargetDir)) return;

	// Scan for .js files and generate specifiers
	const subpathPrefix = subpathPattern.replace(/\/?\*$/, "").replace(/^\.\//, "");
	scanDirForExports(packageName, fullTargetDir, subpathPrefix, aliases);
}

/**
 * Recursively scan a directory for .js files and register them as aliases.
 */
function scanDirForExports(
	packageName: string,
	dir: string,
	relativePath: string,
	aliases: Record<string, string>,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			// Skip examples/test directories — extensions don't need them
			if (entry.name === "examples" || entry.name === "__tests__" || entry.name === "test") continue;
			scanDirForExports(packageName, path.join(dir, entry.name), entryRelative, aliases);
		} else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.js")) {
			const filePath = path.join(dir, entry.name);
			const specifier = `${packageName}/${entryRelative}`;
			// Only add if not already covered by an explicit export
			if (!(specifier in aliases)) {
				aliases[specifier] = filePath;
			}
			// Also add bare (no .js) variant
			const bareSpecifier = specifier.replace(/\.js$/, "");
			if (!(bareSpecifier in aliases)) {
				aliases[bareSpecifier] = filePath;
			}
		}
	}
}

function logExtensionTiming(extensionPath: string, ms: number, outcome: "loaded" | "failed"): void {
	if (!EXTENSION_TIMING_ENABLED) return;
	console.error(`[startup] extension ${outcome}: ${extensionPath} (${ms}ms)`);
}

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;
function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("@sinclair/typebox");
	const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, "");

	const yamlEntry = require.resolve("yaml");
	const yamlRoot = yamlEntry.replace(/[\\/]dist[\\/]index\.js$/, "");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	// Auto-discover subpath exports from bundled npm packages.
	// This ensures extensions can import any standard subpath (e.g. @modelcontextprotocol/sdk/server)
	// without hitting jiti's CJS double-resolve bug.
	const autoDiscovered: Record<string, string> = {};
	for (const packageName of BUNDLED_PACKAGES_WITH_EXPORTS) {
		const subpathAliases = resolveSubpathExports(packageName);
		Object.assign(autoDiscovered, subpathAliases);
	}

	_aliases = {
		// Auto-discovered subpath exports (lowest priority — overridden by manual entries below)
		...autoDiscovered,
		// Manual entries for workspace packages and packages needing special resolution
		"@gsd/pi-coding-agent": packageIndex,
		"@gsd/pi-agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@gsd/pi-agent-core"),
		"@gsd/pi-tui": resolveWorkspaceOrImport("tui/dist/index.js", "@gsd/pi-tui"),
		"@gsd/pi-ai": resolveWorkspaceOrImport("ai/dist/index.js", "@gsd/pi-ai"),
		"@gsd/pi-ai/oauth": resolveWorkspaceOrImport("ai/dist/oauth.js", "@gsd/pi-ai/oauth"),
		"@sinclair/typebox": typeboxRoot,
		"yaml": yamlRoot,
		// Aliases for external PI ecosystem packages that import from the original scope
		"@mariozechner/pi-coding-agent": packageIndex,
		"@mariozechner/pi-agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@gsd/pi-agent-core"),
		"@mariozechner/pi-tui": resolveWorkspaceOrImport("tui/dist/index.js", "@gsd/pi-tui"),
		"@mariozechner/pi-ai": resolveWorkspaceOrImport("ai/dist/index.js", "@gsd/pi-ai"),
		"@mariozechner/pi-ai/oauth": resolveWorkspaceOrImport("ai/dist/oauth.js", "@gsd/pi-ai/oauth"),
	};

	return _aliases;
}

function getJitiOptions() {
	return isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() };
}

const _moduleImporters = new Map<string, ReturnType<typeof createJiti>>();

function getModuleImporter(parentModuleUrl: string) {
	let importer = _moduleImporters.get(parentModuleUrl);
	if (!importer) {
		importer = createJiti(parentModuleUrl, {
			moduleCache: true,
			...getJitiOptions(),
		});
		_moduleImporters.set(parentModuleUrl, importer);
	}
	return importer;
}

export async function importExtensionModule<T = unknown>(parentModuleUrl: string, specifier: string): Promise<T> {
	const importer = getModuleImporter(parentModuleUrl);
	const resolvedPath = fileURLToPath(new URL(specifier, parentModuleUrl));
	return importer.import(resolvedPath) as Promise<T>;
}

const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		retryLastTurn: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config) => {
			runtime.pendingProviderRegistrations.push({ name, config });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
		// Stubs replaced by ExtensionRunner at construction time via bindEmitMethods().
		emitBeforeModelSelect: async () => undefined,
		emitAdjustToolSet: async () => undefined,
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			extension.tools.set(tool.name, {
				definition: tool,
				extensionPath: extension.path,
			});
			// ADR-005: auto-register tool compatibility metadata
			if (tool.compatibility) {
				registerToolCompatibility(tool.name, tool.compatibility);
			}
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
			extension.commands.set(name, { name, ...options });
		},

		registerBeforeInstall(handler: LifecycleHookHandler): void {
			extension.lifecycleHooks.beforeInstall.push(handler);
		},

		registerAfterInstall(handler: LifecycleHookHandler): void {
			extension.lifecycleHooks.afterInstall.push(handler);
		},

		registerBeforeRemove(handler: LifecycleHookHandler): void {
			extension.lifecycleHooks.beforeRemove.push(handler);
		},

		registerAfterRemove(handler: LifecycleHookHandler): void {
			extension.lifecycleHooks.afterRemove.push(handler);
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
			},
		): void {
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.sendUserMessage(content, options);
		},

		retryLastTurn(): void {
			runtime.retryLastTurn();
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			return runtime.getActiveTools();
		},

		getAllTools() {
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			return runtime.getCommands();
		},

		setModel(model) {
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.registerProvider(name, config);
		},

		unregisterProvider(name: string) {
			runtime.unregisterProvider(name);
		},

		async emitBeforeModelSelect(event: Omit<import("./types.js").BeforeModelSelectEvent, "type">): Promise<import("./types.js").BeforeModelSelectResult | undefined> {
			return runtime.emitBeforeModelSelect(event);
		},

		async emitAdjustToolSet(event: Omit<import("./types.js").AdjustToolSetEvent, "type">): Promise<import("./types.js").AdjustToolSetResult | undefined> {
			return runtime.emitAdjustToolSet(event);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

/**
 * Heuristic patterns that indicate TypeScript syntax in a source file.
 * Used to detect when a .js file accidentally contains TypeScript code
 * and provide a helpful error message instead of a cryptic parse failure.
 */
const TS_SYNTAX_PATTERNS: RegExp[] = [
	// Variable type annotations: const name: string, let count: number
	/\b(?:const|let|var)\s+\w+\s*:\s*(?:string|number|boolean|any|void|never|unknown|object|bigint|symbol|undefined|null)\b/,
	// Parameter type annotations: (api: ExtensionAPI)
	/\(\s*\w+\s*:\s*[A-Z]\w*/,
	// Return type annotations: ): Promise<void> {  or  ): string =>
	/\)\s*:\s*(?:Promise|string|number|boolean|void|any|never|unknown)\b/,
	// Interface declarations
	/\binterface\s+[A-Z]\w*\s*(?:<[^>]*>)?\s*\{/,
	// Type alias declarations
	/\btype\s+[A-Z]\w*\s*(?:<[^>]*>)?\s*=/,
	// Angle-bracket type assertions: <Type>value
	/(?:as\s+\w+(?:<[^>]*>)?)\s*[;,)\]}]/,
	// Generic type parameters on functions: function foo<T>
	/\bfunction\s+\w+\s*<[^>]+>/,
	// Enum declarations
	/\benum\s+[A-Z]\w*\s*\{/,
];

/**
 * Check whether a source string likely contains TypeScript syntax.
 * This is a heuristic — it may produce false positives for unusual JS,
 * but is tuned to catch the most common TS-in-JS mistakes.
 */
export function containsTypeScriptSyntax(source: string): boolean {
	return TS_SYNTAX_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * Shared jiti instance for loading extension modules.
 *
 * Before this fix (#2108), each extension created a NEW jiti instance with
 * `moduleCache: false`, causing shared dependencies (e.g. @gsd/pi-agent-core)
 * to be recompiled for every extension — turning a ~3s parallel load into a
 * ~15-30s serial compilation bottleneck.
 *
 * Using a single shared instance with `moduleCache: true` means shared modules
 * are compiled once and reused across all extensions.
 */
let _extensionLoaderJiti: ReturnType<typeof createJiti> | null = null;

/**
 * Reset the shared jiti singleton so the next call to getExtensionLoaderJiti()
 * creates a fresh instance.  This prevents memory leaks in long-running daemon
 * processes (every loaded module stays cached forever) and ensures stale modules
 * are not returned when extension source changes on disk.
 */
export function resetExtensionLoaderCache(): void {
	_extensionLoaderJiti = null;
}

function getExtensionLoaderJiti() {
	if (!_extensionLoaderJiti) {
		_extensionLoaderJiti = createJiti(import.meta.url, {
			moduleCache: true,
			...getJitiOptions(),
		});
	}
	return _extensionLoaderJiti;
}

async function loadExtensionModule(extensionPath: string) {
	// Pre-compiled extension loading: if the source is .ts and a sibling .js
	// file exists with matching or newer mtime, use native import() to skip
	// jiti JIT compilation entirely.  This is the biggest startup win for
	// bundled extensions that have already been built.
	if (extensionPath.endsWith(".ts")) {
		const jsPath = extensionPath.replace(/\.ts$/, ".js");
		try {
			const [tsStat, jsStat] = [fs.statSync(extensionPath), fs.statSync(jsPath)];
			if (jsStat.mtimeMs >= tsStat.mtimeMs) {
				const module = await import(jsPath);
				const factory = (module.default ?? module) as ExtensionFactory;
				return typeof factory !== "function" ? undefined : factory;
			}
		} catch {
			// .js file doesn't exist or stat failed — fall through to jiti
		}
	}

	const jiti = getExtensionLoaderJiti();

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * Check whether a module path belongs to a non-extension library that should
 * be silently skipped rather than reported as an error.
 *
 * A directory is a non-extension library when its package.json has a "pi"
 * manifest that declares no extensions (e.g. `"pi": {}`). This is the
 * opt-out convention used by shared libraries like cmux that live inside
 * the extensions/ directory but are not extensions themselves.
 *
 * This serves as a defense-in-depth check: even if the upstream discovery
 * layers fail to filter out the library, the loader itself will not emit
 * a spurious error.
 */
function isNonExtensionLibrary(resolvedPath: string): boolean {
	// Walk up from the resolved file to find the nearest package.json
	let dir = path.dirname(resolvedPath);
	const root = path.parse(dir).root;
	while (dir !== root) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const content = fs.readFileSync(packageJsonPath, "utf-8");
				const pkg = JSON.parse(content);
				if (pkg.pi && typeof pkg.pi === "object") {
					// Has a pi manifest — check if it declares any extensions
					const extensions = pkg.pi.extensions;
					if (!Array.isArray(extensions) || extensions.length === 0) {
						return true;
					}
				}
			} catch {
				// Malformed package.json — not a known library
			}
			break;
		}
		dir = path.dirname(dir);
	}
	return false;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		lifecycleHooks: {
			beforeInstall: [],
			afterInstall: [],
			beforeRemove: [],
			afterRemove: [],
		},
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	const start = Date.now();

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			// Defense-in-depth: if the module is inside a directory that has
			// explicitly opted out of extension loading via its pi manifest,
			// silently skip it instead of reporting a spurious error.
			if (isNonExtensionLibrary(resolvedPath)) {
				return { extension: null, error: null };
			}
			logExtensionTiming(extensionPath, Date.now() - start, "failed");

			// Check if a .js file contains TypeScript syntax
			if (resolvedPath.endsWith(".js")) {
				try {
					const source = fs.readFileSync(resolvedPath, "utf-8");
					if (containsTypeScriptSyntax(source)) {
						return {
							extension: null,
							error: `Extension file "${extensionPath}" appears to contain TypeScript syntax but has a .js extension. Rename it to .ts so the loader can compile it.`,
						};
					}
				} catch {
					// Could not read file — fall through to generic error
				}
			}

			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);
		logExtensionTiming(extensionPath, Date.now() - start, "loaded");

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logExtensionTiming(extensionPath, Date.now() - start, "failed");

		// Check if a .js file contains TypeScript syntax — the parse error from
		// jiti/Node is often cryptic, so surface a clearer diagnostic.
		if (resolvedPath.endsWith(".js")) {
			try {
				const source = fs.readFileSync(resolvedPath, "utf-8");
				if (containsTypeScriptSyntax(source)) {
					return {
						extension: null,
						error: `Extension file "${extensionPath}" appears to contain TypeScript syntax but has a .js extension. Rename it to .ts so the loader can compile it.`,
					};
				}
			} catch {
				// Could not read file — fall through to generic error
			}
		}

		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Extensions are loaded in parallel to reduce wall-clock time (~30-50% faster
 * than sequential loading for I/O-bound jiti compilation).
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	const results = await Promise.all(
		paths.map((extPath) => loadExtension(extPath, cwd, resolvedEventBus, runtime)),
	);

	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (let i = 0; i < results.length; i++) {
		const { extension, error } = results[i];
		if (error) {
			errors.push({ path: paths[i], error });
		} else if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest) {
			// When a pi manifest exists, it is authoritative — don't fall through
			// to index.ts/index.js auto-detection. This allows library directories
			// (like cmux) to opt out by declaring "pi": {} with no extensions.
			if (!manifest.extensions?.length) {
				return null;
			}
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			return entries.length > 0 ? entries : null;
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 *
 * @deprecated Use DefaultResourceLoader.reload() instead — this function is
 * not called in the GSD loading flow. Extension discovery happens through
 * DefaultPackageManager.resolve() → addAutoDiscoveredResources(). Kept for
 * backwards compatibility with direct pi-coding-agent consumers.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/.pi/extensions/
	// Only loaded when the project path has been explicitly trusted (TOFU model).
	const localExtDir = path.join(cwd, ".pi", "extensions");
	const localDiscovered = discoverExtensionsInDir(localExtDir);
	if (localDiscovered.length > 0) {
		const untrusted = getUntrustedExtensionPaths(cwd, localDiscovered, agentDir);
		if (untrusted.length > 0) {
			process.stderr.write(
				`[pi] Skipping ${untrusted.length} project-local extension(s) in ${localExtDir} — project not trusted. Use trustProject() to enable.\n`,
			);
		}
		const trusted = localDiscovered.filter((p) => !untrusted.includes(p));
		addPaths(trusted);
	}

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(agentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
