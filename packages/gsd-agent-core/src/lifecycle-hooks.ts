import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseGitUrl } from "@gsd/pi-coding-agent";
import type { PackageManager } from "@gsd/agent-types";
import type {
	LifecycleHookContext,
	LifecycleHookMap,
	LifecycleHookHandler,
	LifecycleHookPhase,
	LifecycleHookScope,
} from "@gsd/agent-types";

interface ExtensionManifest {
	dependencies?: {
		runtime?: string[];
	};
}

export interface PackageLifecycleHooksOptions {
	source: string;
	local: boolean;
	cwd: string;
	agentDir: string;
	appName: string;
	packageManager: PackageManager;
	stdout: NodeJS.WriteStream;
	stderr: NodeJS.WriteStream;
}

export type LifecycleHooksTarget = "source" | "installed";

export interface PrepareLifecycleHooksOptions {
	verifyRuntimeDependencies?: boolean;
}

export interface LifecycleHooksRunResult {
	phase: LifecycleHookPhase;
	hooksRun: number;
	hookErrors: number;
	legacyHooksRun: number;
	entryPathCount: number;
	skipped: boolean;
}

interface LoadedLifecycleHooks {
	source: string;
	scope: LifecycleHookScope;
	installedPath?: string;
	cwd: string;
	stdout: NodeJS.WriteStream;
	stderr: NodeJS.WriteStream;
	entryPaths: string[];
	hooksByPath: Map<string, LifecycleHookMap>;
}

function toScope(local: boolean): LifecycleHookScope {
	return local ? "project" : "user";
}

export function readManifestRuntimeDeps(dir: string): string[] {
	const manifestPath = join(dir, "extension-manifest.json");
	if (!existsSync(manifestPath)) return [];
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExtensionManifest;
		return manifest.dependencies?.runtime?.filter((dep): dep is string => typeof dep === "string") ?? [];
	} catch {
		return [];
	}
}

export function collectRuntimeDependencies(installedPath: string, entryPaths: string[]): string[] {
	const deps = new Set<string>();
	const candidateDirs = new Set<string>([installedPath, ...entryPaths.map((entryPath) => dirname(entryPath))]);
	for (const dir of candidateDirs) {
		for (const dep of readManifestRuntimeDeps(dir)) {
			deps.add(dep);
		}
	}
	return Array.from(deps);
}

export function verifyRuntimeDependencies(runtimeDeps: string[], source: string, appName: string): void {
	const missing: string[] = [];
	for (const dep of runtimeDeps) {
		const result = spawnSync(dep, ["--version"], { encoding: "utf-8", timeout: 5000 });
		if (result.error || result.status !== 0) {
			missing.push(dep);
		}
	}
	if (missing.length === 0) return;
	throw new Error(
		`Missing runtime dependencies: ${missing.join(", ")}.\n` +
			`Install them and retry: ${appName} install ${source}`,
	);
}

export function resolveLocalSourcePath(source: string, cwd: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("npm:")) return undefined;
	if (parseGitUrl(trimmed)) return undefined;

	let normalized = trimmed;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/")) {
		normalized = join(homedir(), normalized.slice(2));
	}

	const absolutePath = resolve(cwd, normalized);
	return existsSync(absolutePath) ? absolutePath : undefined;
}

async function resolveEntryPathsFromTarget(
	options: PackageLifecycleHooksOptions,
	target: LifecycleHooksTarget,
	scope: LifecycleHookScope,
): Promise<{ entryPaths: string[]; installedPath?: string }> {
	if (target === "source") {
		const localSourcePath = resolveLocalSourcePath(options.source, options.cwd);
		if (!localSourcePath) return { entryPaths: [] };
		const resolved = await options.packageManager.resolveExtensionSources([localSourcePath], { local: true });
		const entryPaths = resolved.extensions.filter((resource) => resource.enabled).map((resource) => resource.path);
		return { entryPaths, installedPath: localSourcePath };
	}

	const installedPath = options.packageManager.getInstalledPath(options.source, scope);
	if (!installedPath) return { entryPaths: [] };
	const resolved = await options.packageManager.resolveExtensionSources([installedPath], { local: true });
	const entryPaths = resolved.extensions.filter((resource) => resource.enabled).map((resource) => resource.path);
	return { entryPaths, installedPath };
}

export async function prepareLifecycleHooks(
	options: PackageLifecycleHooksOptions,
	target: LifecycleHooksTarget,
	prepareOptions?: PrepareLifecycleHooksOptions,
): Promise<LoadedLifecycleHooks | null> {
	const scope = toScope(options.local);
	const { entryPaths, installedPath } = await resolveEntryPathsFromTarget(options, target, scope);
	if (entryPaths.length === 0) {
		return null;
	}

	if (prepareOptions?.verifyRuntimeDependencies && installedPath) {
		const runtimeDeps = collectRuntimeDependencies(installedPath, entryPaths);
		verifyRuntimeDependencies(runtimeDeps, options.source, options.appName);
	}

	// extension.lifecycleHooks and the loadExtensions-based registration path were
	// removed from the Extension interface in 0.67.2. Only the legacy export path
	// (runLegacyExportHook via dynamic import()) is used now. Pre-populate hooksByPath
	// with empty maps so runLifecycleHooks falls through to runLegacyExportHook for
	// every entry path.
	const hooksByPath = new Map<string, LifecycleHookMap>();
	for (const entryPath of entryPaths) {
		hooksByPath.set(entryPath, {});
	}

	return {
		source: options.source,
		scope,
		installedPath,
		cwd: options.cwd,
		stdout: options.stdout,
		stderr: options.stderr,
		entryPaths,
		hooksByPath,
	};
}

async function runHookSafe(
	hook: LifecycleHookHandler,
	context: LifecycleHookContext,
	stderr: NodeJS.WriteStream,
): Promise<boolean> {
	try {
		await hook(context);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr.write(`[lifecycle-hooks:${context.phase}] Hook failed: ${message}\n`);
		return false;
	}
}

function getLegacyExportCandidates(phase: LifecycleHookPhase): string[] {
	return [phase];
}

const _legacyModuleCache = new Map<string, Record<string, unknown>>();

async function runLegacyExportHook(
	entryPath: string,
	phase: LifecycleHookPhase,
	context: LifecycleHookContext,
): Promise<LifecycleHookHandler | null> {
	try {
		let module: Record<string, unknown> | undefined = _legacyModuleCache.get(entryPath);
		if (!module) {
			module = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
			if (!module) return null;
			_legacyModuleCache.set(entryPath, module);
		}
		for (const exportName of getLegacyExportCandidates(phase)) {
			const candidate = module[exportName];
			if (typeof candidate === "function") {
				return candidate as LifecycleHookHandler;
			}
		}
		return null;
	} catch {
		return null;
	}
}

export async function runLifecycleHooks(
	loaded: LoadedLifecycleHooks | null,
	phase: LifecycleHookPhase,
): Promise<LifecycleHooksRunResult> {
	if (!loaded) {
		return {
			phase,
			hooksRun: 0,
			hookErrors: 0,
			legacyHooksRun: 0,
			entryPathCount: 0,
			skipped: true,
		};
	}

	const context: LifecycleHookContext = {
		phase,
		source: loaded.source,
		installedPath: loaded.installedPath,
		scope: loaded.scope,
		cwd: loaded.cwd,
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		log: (message: string) => loaded.stdout.write(`${message}\n`),
		warn: (message: string) => loaded.stderr.write(`${message}\n`),
		error: (message: string) => loaded.stderr.write(`${message}\n`),
	};

	let hooksRun = 0;
	let hookErrors = 0;
	let legacyHooksRun = 0;

	for (const entryPath of loaded.entryPaths) {
		const hookMap = loaded.hooksByPath.get(entryPath);
		const registeredHooks = hookMap?.[phase] ?? [];
		if (registeredHooks.length > 0) {
			for (const hook of registeredHooks) {
				hooksRun += 1;
				const ok = await runHookSafe(hook, context, loaded.stderr);
				if (!ok) hookErrors += 1;
			}
			continue;
		}

		const legacyHook = await runLegacyExportHook(entryPath, phase, context);
		if (!legacyHook) continue;

		legacyHooksRun += 1;
		const ok = await runHookSafe(legacyHook, context, loaded.stderr);
		if (!ok) hookErrors += 1;
	}

	return {
		phase,
		hooksRun,
		hookErrors,
		legacyHooksRun,
		entryPathCount: loaded.entryPaths.length,
		skipped: false,
	};
}
