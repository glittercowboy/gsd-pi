import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.js";
import type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.js";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.js";

import { createEventBus, type EventBus } from "./event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions, resetExtensionLoaderCache } from "./extensions/loader.js";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.js";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.js";
import type { PromptTemplate } from "./prompt-templates.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { SettingsManager } from "./settings-manager.js";
import type { Skill } from "./skills.js";
import { loadSkills } from "./skills.js";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	getPathMetadata(): Map<string, PathMetadata>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(): Promise<void>;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

function loadProjectContextFiles(
	options: { cwd?: string; agentDir?: string } = {},
): Array<{ path: string; content: string }> {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getAgentDir();

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface DefaultResourceLoaderOptions {
	cwd?: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	bundledExtensionKeys?: Set<string>;
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** Names of bundled extensions (used to identify built-in extensions in conflict detection). */
	bundledExtensionNames?: Set<string>;
	/**
	 * Transform extension paths before loading. Receives the merged list of all
	 * discovered extension paths and returns a (possibly reordered/filtered) list.
	 * Use this to apply dependency sorting or registry-based filtering.
	 */
	extensionPathsTransform?: (paths: string[]) => { paths: string[]; diagnostics?: string[] };
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private bundledExtensionKeys: Set<string>;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string;
	private bundledExtensionNames: Set<string>;
	private extensionPathsTransform?: (paths: string[]) => { paths: string[]; diagnostics?: string[] };
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private pathMetadata: Map<string, PathMetadata>;
	private lastSkillPaths: string[];
	private lastPromptPaths: string[];
	private lastThemePaths: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = options.cwd ?? process.cwd();
		this.agentDir = options.agentDir ?? getAgentDir();
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.bundledExtensionKeys = options.bundledExtensionKeys ?? new Set();
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.extensionFactories = options.extensionFactories ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.bundledExtensionNames = options.bundledExtensionNames ?? new Set();
		this.extensionPathsTransform = options.extensionPathsTransform;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.pathMetadata = new Map();
		this.lastSkillPaths = [];
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getPathMetadata(): Map<string, PathMetadata> {
		return this.pathMetadata;
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths, skillPaths);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths, promptPaths);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths, themePaths);
		}
	}

	async reload(): Promise<void> {
		// Invalidate the shared jiti module cache so updated extension code
		// on disk is re-compiled instead of served from the stale cache (#3616).
		resetExtensionLoaderCache();

		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});

		// Helper to extract enabled paths and store metadata
		const getEnabledResources = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> => {
			for (const r of resources) {
				if (!this.pathMetadata.has(r.path)) {
					this.pathMetadata.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): string[] => getEnabledResources(resources).map((r) => r.path);

		// Store metadata and get enabled paths
		this.pathMetadata = new Map();
		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		const mapSkillPath = (resource: { path: string; metadata: PathMetadata }): string => {
			if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
				return resource.path;
			}
			try {
				const stats = statSync(resource.path);
				if (!stats.isDirectory()) {
					return resource.path;
				}
			} catch {
				return resource.path;
			}
			const skillFile = join(resource.path, "SKILL.md");
			if (existsSync(skillFile)) {
				if (!this.pathMetadata.has(skillFile)) {
					this.pathMetadata.set(skillFile, resource.metadata);
				}
				return skillFile;
			}
			return resource.path;
		};

		const enabledSkills = enabledSkillResources.map(mapSkillPath);

		// Add CLI paths metadata
		for (const r of cliExtensionPaths.extensions) {
			if (!this.pathMetadata.has(r.path)) {
				this.pathMetadata.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of cliExtensionPaths.skills) {
			if (!this.pathMetadata.has(r.path)) {
				this.pathMetadata.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		let extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);

		// Apply path transform (dependency sorting, registry filtering) if provided
		if (this.extensionPathsTransform) {
			const transformed = this.extensionPathsTransform(extensionPaths);
			extensionPaths = transformed.paths;
			if (transformed.diagnostics?.length) {
				for (const msg of transformed.diagnostics) {
					process.stderr.write(`[extensions] ${msg}\n`);
				}
			}
		}

		const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);

		// Detect extension conflicts (tools, commands, flags with same names from different extensions)
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}

		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;

		const skillPaths = this.noSkills
			? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
			: this.mergePaths([...enabledSkills, ...cliEnabledSkills], this.additionalSkillPaths);

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths);

		const promptPaths = this.noPromptTemplates
			? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: this.mergePaths([...enabledPrompts, ...cliEnabledPrompts], this.additionalPromptTemplatePaths);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths);

		const themePaths = this.noThemes
			? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: this.mergePaths([...enabledThemes, ...cliEnabledThemes], this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths);

		for (const extension of this.extensionsResult.extensions) {
			this.addDefaultMetadataForPath(extension.path);
		}

		const agentsFiles = { agentsFiles: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }) };
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const baseSystemPrompt = resolvePromptInput(
			this.systemPromptSource ?? this.discoverFileInSearchPaths("SYSTEM.md"),
			"system prompt",
		);
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

		const appendSource = this.appendSystemPromptSource ?? this.discoverFileInSearchPaths("APPEND_SYSTEM.md");
		const resolvedAppend = resolvePromptInput(appendSource, "append system prompt");
		const baseAppend = resolvedAppend ? [resolvedAppend] : [];
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => ({
			path: this.resolveResourcePath(entry.path),
			metadata: entry.metadata,
		}));
	}

	private updateSkillsFromPaths(
		skillPaths: string[],
		extensionPaths: Array<{ path: string; metadata: PathMetadata }> = [],
	): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills;
		this.skillDiagnostics = resolvedSkills.diagnostics;
		this.applyExtensionMetadata(
			extensionPaths,
			this.skills.map((skill) => skill.filePath),
		);
		for (const skill of this.skills) {
			this.addDefaultMetadataForPath(skill.filePath);
		}
	}

	private updatePromptsFromPaths(
		promptPaths: string[],
		extensionPaths: Array<{ path: string; metadata: PathMetadata }> = [],
	): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			const deduped = this.dedupeResources(allPrompts, {
				getName: (p) => p.name,
				getPath: (p) => p.filePath,
				resourceType: "prompt",
				namePrefix: "/",
			});
			promptsResult = { prompts: deduped.items, diagnostics: deduped.diagnostics };
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts;
		this.promptDiagnostics = resolvedPrompts.diagnostics;
		this.applyExtensionMetadata(
			extensionPaths,
			this.prompts.map((prompt) => prompt.filePath),
		);
		for (const prompt of this.prompts) {
			this.addDefaultMetadataForPath(prompt.filePath);
		}
	}

	private updateThemesFromPaths(
		themePaths: string[],
		extensionPaths: Array<{ path: string; metadata: PathMetadata }> = [],
	): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeResources(loaded.themes, {
				getName: (t) => t.name ?? "unnamed",
				getPath: (t) => t.sourcePath,
				resourceType: "theme",
			});
			themesResult = { themes: deduped.items, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes;
		this.themeDiagnostics = resolvedThemes.diagnostics;
		const themePathsWithSource = this.themes.flatMap((theme) => (theme.sourcePath ? [theme.sourcePath] : []));
		this.applyExtensionMetadata(extensionPaths, themePathsWithSource);
		for (const theme of this.themes) {
			if (theme.sourcePath) {
				this.addDefaultMetadataForPath(theme.sourcePath);
			}
		}
	}

	private applyExtensionMetadata(
		extensionPaths: Array<{ path: string; metadata: PathMetadata }>,
		resourcePaths: string[],
	): void {
		if (extensionPaths.length === 0) {
			return;
		}

		const normalized = extensionPaths.map((entry) => ({
			path: resolve(entry.path),
			metadata: entry.metadata,
		}));

		for (const entry of normalized) {
			if (!this.pathMetadata.has(entry.path)) {
				this.pathMetadata.set(entry.path, entry.metadata);
			}
		}

		for (const resourcePath of resourcePaths) {
			const normalizedResourcePath = resolve(resourcePath);
			if (this.pathMetadata.has(normalizedResourcePath) || this.pathMetadata.has(resourcePath)) {
				continue;
			}
			const match = normalized.find(
				(entry) =>
					normalizedResourcePath === entry.path || normalizedResourcePath.startsWith(`${entry.path}${sep}`),
			);
			if (match) {
				this.pathMetadata.set(normalizedResourcePath, match.metadata);
			}
		}
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		const trimmed = p.trim();
		let expanded = trimmed;
		if (trimmed === "~") {
			expanded = homedir();
		} else if (trimmed.startsWith("~/")) {
			expanded = join(homedir(), trimmed.slice(2));
		} else if (trimmed.startsWith("~")) {
			expanded = join(homedir(), trimmed.slice(1));
		}
		return resolve(this.cwd, expanded);
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = resolve(this.cwd, p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupeResources<T>(
		items: T[],
		options: {
			getName: (item: T) => string;
			getPath: (item: T) => string | undefined;
			resourceType: ResourceCollision["resourceType"];
			namePrefix?: string;
		},
	): { items: T[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, T>();
		const diagnostics: ResourceDiagnostic[] = [];
		const { getName, getPath, resourceType, namePrefix = "" } = options;

		for (const item of items) {
			const name = getName(item);
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${namePrefix}${name}" collision`,
					path: getPath(item),
					collision: {
						resourceType,
						name,
						winnerPath: getPath(existing) ?? "<builtin>",
						loserPath: getPath(item) ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, item);
			}
		}

		return { items: Array.from(seen.values()), diagnostics };
	}

	private discoverFileInSearchPaths(filename: string): string | undefined {
		const searchDirs = [join(this.cwd, CONFIG_DIR_NAME), this.agentDir];
		for (const dir of searchDirs) {
			const filePath = join(dir, filename);
			if (existsSync(filePath)) {
				return filePath;
			}
		}
		return undefined;
	}

	private addDefaultMetadataForPath(filePath: string): void {
		if (!filePath || filePath.startsWith("<")) {
			return;
		}

		const normalizedPath = resolve(filePath);
		if (this.pathMetadata.has(normalizedPath) || this.pathMetadata.has(filePath)) {
			return;
		}

		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				this.pathMetadata.set(normalizedPath, { source: "local", scope: "user", origin: "top-level" });
				return;
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				this.pathMetadata.set(normalizedPath, { source: "local", scope: "project", origin: "top-level" });
				return;
			}
		}
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	/**
	 * Extract the extension name from its path.
	 * For root-level files: basename without extension (e.g. "search-the-web.ts" → "search-the-web")
	 * For subdirectory extensions: the directory name (e.g. "/path/to/gsd/index.ts" → "gsd")
	 */
	private getExtensionNameFromPath(extPath: string): string {
		const base = basename(extPath);
		if (base === "index.js" || base === "index.ts") {
			return basename(dirname(extPath));
		}
		return base.replace(/\.(?:ts|js)$/, "");
	}

	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		return detectExtensionConflicts(extensions, this.bundledExtensionKeys, join(this.agentDir, "extensions"));
	}
}

/**
 * Extract the extension directory name (key) from a full extension path.
 * Given extensionsDir `/home/user/.gsd/agent/extensions` and
 * ownerPath `/home/user/.gsd/agent/extensions/mcp-client/index.js`,
 * returns `"mcp-client"`.  Returns `undefined` when the path is not
 * under extensionsDir.
 */
export function extractExtensionKey(ownerPath: string, extensionsDir: string): string | undefined {
	const normalizedDir = resolve(extensionsDir);
	const normalizedPath = resolve(ownerPath);
	const prefix = normalizedDir.endsWith(sep) ? normalizedDir : `${normalizedDir}${sep}`;
	if (!normalizedPath.startsWith(prefix)) {
		return undefined;
	}
	const relPath = relative(normalizedDir, normalizedPath);
	const firstSegment = relPath.split(/[\\/]/)[0];
	return firstSegment?.replace(/\.(?:ts|js)$/, "") || undefined;
}

/**
 * Detect tool/command/flag name collisions across loaded extensions.
 *
 * When the first-registered owner of a name is a bundled extension
 * (its key appears in `bundledExtensionKeys`), the conflict message
 * includes a "supersedes" hint so downstream display can downgrade the
 * severity from "Extension load error" to "Extension conflict".
 */
export function detectExtensionConflicts(
	extensions: Extension[],
	bundledExtensionKeys: Set<string>,
	extensionsDir: string,
): Array<{ path: string; message: string }> {
	const conflicts: Array<{ path: string; message: string }> = [];

	const toolOwners = new Map<string, string>();
	const commandOwners = new Map<string, string>();
	const flagOwners = new Map<string, string>();

	const isBundled = (ownerPath: string): boolean => {
		const key = extractExtensionKey(ownerPath, extensionsDir);
		return key !== undefined && bundledExtensionKeys.has(key);
	};

	for (const ext of extensions) {
		for (const toolName of ext.tools.keys()) {
			const existingOwner = toolOwners.get(toolName);
			if (existingOwner && existingOwner !== ext.path) {
				const hint = isBundled(existingOwner)
					? ` (built-in tool supersedes — consider removing ${ext.path})`
					: "";
				conflicts.push({
					path: ext.path,
					message: `Tool "${toolName}" conflicts with ${existingOwner}${hint}`,
				});
			} else {
				toolOwners.set(toolName, ext.path);
			}
		}

		for (const commandName of ext.commands.keys()) {
			const existingOwner = commandOwners.get(commandName);
			if (existingOwner && existingOwner !== ext.path) {
				const hint = isBundled(existingOwner)
					? ` (built-in command supersedes — consider removing ${ext.path})`
					: "";
				conflicts.push({
					path: ext.path,
					message: `Command "/${commandName}" conflicts with ${existingOwner}${hint}`,
				});
			} else {
				commandOwners.set(commandName, ext.path);
			}
		}

		for (const flagName of ext.flags.keys()) {
			const existingOwner = flagOwners.get(flagName);
			if (existingOwner && existingOwner !== ext.path) {
				conflicts.push({
					path: ext.path,
					message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
				});
			} else {
				flagOwners.set(flagName, ext.path);
			}
		}
	}

	return conflicts;
}
