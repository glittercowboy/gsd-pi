import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import { isEnoent } from "./helpers.js";
import type {
	CallHierarchyItem,
	CodeAction,
	Command,
	Diagnostic,
	DiagnosticSeverity,
	DocumentSymbol,
	Location,
	MarkupContent,
	SignatureHelp,
	SymbolInformation,
	SymbolKind,
	TextEdit,
	WorkspaceEdit,
} from "./types.js";

// =============================================================================
// Language Detection
// =============================================================================

const LANGUAGE_MAP: Record<string, string> = {
	// TypeScript/JavaScript
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".mts": "typescript",
	".cts": "typescript",

	// Systems languages
	".rs": "rust",
	".go": "go",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".zig": "zig",

	// Scripting languages
	".py": "python",
	".rb": "ruby",
	".lua": "lua",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".fish": "fish",
	".pl": "perl",
	".php": "php",

	// JVM languages
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".scala": "scala",
	".groovy": "groovy",
	".clj": "clojure",

	// .NET languages
	".cs": "csharp",
	".fs": "fsharp",
	".vb": "vb",

	// Web
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "scss",
	".sass": "sass",
	".less": "less",
	".vue": "vue",
	".svelte": "svelte",

	// Data formats
	".json": "json",
	".jsonc": "jsonc",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".xml": "xml",
	".ini": "ini",

	// Documentation
	".md": "markdown",
	".markdown": "markdown",
	".rst": "restructuredtext",
	".adoc": "asciidoc",
	".tex": "latex",

	// Other
	".sql": "sql",
	".graphql": "graphql",
	".gql": "graphql",
	".proto": "protobuf",
	".dockerfile": "dockerfile",
	".tf": "terraform",
	".hcl": "hcl",
	".nix": "nix",
	".ex": "elixir",
	".exs": "elixir",
	".erl": "erlang",
	".hrl": "erlang",
	".hs": "haskell",
	".ml": "ocaml",
	".mli": "ocaml",
	".swift": "swift",
	".r": "r",
	".R": "r",
	".jl": "julia",
	".dart": "dart",
	".elm": "elm",
	".v": "v",
	".nim": "nim",
	".cr": "crystal",
	".d": "d",
	".pas": "pascal",
	".pp": "pascal",
	".lisp": "lisp",
	".lsp": "lisp",
	".rkt": "racket",
	".scm": "scheme",
	".ps1": "powershell",
	".psm1": "powershell",
	".bat": "bat",
	".cmd": "bat",
};

/**
 * Detect language ID from file path.
 */
export function detectLanguageId(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	const basename = path.basename(filePath).toLowerCase();

	if (basename === "dockerfile" || basename.startsWith("dockerfile.")) {
		return "dockerfile";
	}
	if (basename === "makefile" || basename === "gnumakefile") {
		return "makefile";
	}
	if (basename === "cmakelists.txt" || ext === ".cmake") {
		return "cmake";
	}

	return LANGUAGE_MAP[ext] ?? "plaintext";
}

// =============================================================================
// URI Handling (Cross-Platform)
// =============================================================================

export function fileToUri(filePath: string): string {
	const resolved = path.resolve(filePath);

	if (process.platform === "win32") {
		return `file:///${resolved.replace(/\\/g, "/")}`;
	}

	return `file://${resolved}`;
}

export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri;
	}

	let filePath = decodeURIComponent(uri.slice(7));

	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1);
	}

	return filePath;
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

const SEVERITY_NAMES: Record<DiagnosticSeverity, string> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

export function severityToString(severity?: DiagnosticSeverity): string {
	return SEVERITY_NAMES[severity ?? 1] ?? "unknown";
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.sort((a, b) => {
		const aSeverity = a.severity ?? 1;
		const bSeverity = b.severity ?? 1;
		if (aSeverity !== bSeverity) return aSeverity - bSeverity;
		const aLine = a.range.start.line;
		const bLine = b.range.start.line;
		if (aLine !== bLine) return aLine - bLine;
		const aCol = a.range.start.character;
		const bCol = b.range.start.character;
		if (aCol !== bCol) return aCol - bCol;
		return a.message.localeCompare(b.message);
	});
}

export function severityToIcon(severity?: DiagnosticSeverity): string {
	switch (severity ?? 1) {
		case 1:
			return "[E]";
		case 2:
			return "[W]";
		case 3:
			return "[I]";
		case 4:
			return "[H]";
		default:
			return "[E]";
	}
}

function stripDiagnosticNoise(message: string): string {
	return message
		.split("\n")
		.filter(line => {
			const trimmed = line.trim();
			if (trimmed.startsWith("for further information visit")) return false;
			if (/^https?:\/\//.test(trimmed)) return false;
			return true;
		})
		.join("\n")
		.trim();
}

export function formatDiagnostic(diagnostic: Diagnostic, filePath: string): string {
	const severity = severityToString(diagnostic.severity);
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code !== undefined ? ` (${diagnostic.code})` : "";
	const message = stripDiagnosticNoise(diagnostic.message);

	return `${filePath}:${line}:${col} [${severity}] ${source}${message}${code}`;
}

const DIAG_PATH_RE = /^(.+?):(\d+:\d+\s+.*)$/;

export function formatGroupedDiagnosticMessages(messages: string[]): string {
	const diagnosticsByFile = new Map<string, string[]>();
	const fileOrder: string[] = [];
	const ungrouped: string[] = [];

	for (const msg of messages) {
		const match = DIAG_PATH_RE.exec(msg);
		if (!match) {
			ungrouped.push(msg);
			continue;
		}

		const [, rawFilePath, rest] = match;
		const filePath = rawFilePath.replace(/\\/g, "/");
		if (!diagnosticsByFile.has(filePath)) {
			diagnosticsByFile.set(filePath, []);
			fileOrder.push(filePath);
		}
		diagnosticsByFile.get(filePath)?.push(rest);
	}

	if (diagnosticsByFile.size === 0) {
		return ungrouped.join("\n");
	}

	const filesByDirectory = new Map<string, string[]>();
	for (const filePath of fileOrder) {
		const directory = path.dirname(filePath).replace(/\\/g, "/");
		if (!filesByDirectory.has(directory)) {
			filesByDirectory.set(directory, []);
		}
		filesByDirectory.get(directory)?.push(filePath);
	}

	const lines: string[] = [];
	for (const [directory, directoryFiles] of filesByDirectory) {
		if (directory === ".") {
			for (const filePath of directoryFiles) {
				if (lines.length > 0) {
					lines.push("");
				}
				lines.push(`# ${path.basename(filePath)}`);
				for (const diagnostic of diagnosticsByFile.get(filePath) ?? []) {
					lines.push(`  ${diagnostic}`);
				}
			}
			continue;
		}

		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(`# ${directory}`);
		for (const filePath of directoryFiles) {
			lines.push(`## └─ ${path.basename(filePath)}`);
			for (const diagnostic of diagnosticsByFile.get(filePath) ?? []) {
				lines.push(`  ${diagnostic}`);
			}
		}
	}

	if (ungrouped.length > 0) {
		lines.push("");
		for (const msg of ungrouped) {
			lines.push(msg);
		}
	}

	return lines.join("\n");
}

export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };

	for (const d of diagnostics) {
		const sev = severityToString(d.severity);
		if (sev in counts) {
			counts[sev as keyof typeof counts]++;
		}
	}

	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);

	return parts.length > 0 ? parts.join(", ") : "no issues";
}

// =============================================================================
// Location Formatting
// =============================================================================

export function formatLocation(location: Location, cwd: string): string {
	const file = path.relative(cwd, uriToFile(location.uri));
	const line = location.range.start.line + 1;
	const col = location.range.start.character + 1;
	return `${file}:${line}:${col}`;
}

export function formatPosition(line: number, col: number): string {
	return `${line}:${col}`;
}

// =============================================================================
// WorkspaceEdit Formatting
// =============================================================================

export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string[] {
	const results: string[] = [];

	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const file = path.relative(cwd, uriToFile(uri));
			results.push(`${file}: ${textEdits.length} edit${textEdits.length > 1 ? "s" : ""}`);
		}
	}

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("edits" in change && change.textDocument) {
				const file = path.relative(cwd, uriToFile(change.textDocument.uri));
				results.push(`${file}: ${change.edits.length} edit${change.edits.length > 1 ? "s" : ""}`);
			} else if ("kind" in change) {
				switch (change.kind) {
					case "create":
						results.push(`CREATE: ${path.relative(cwd, uriToFile(change.uri))}`);
						break;
					case "rename":
						results.push(
							`RENAME: ${path.relative(cwd, uriToFile(change.oldUri))} -> ${path.relative(cwd, uriToFile(change.newUri))}`,
						);
						break;
					case "delete":
						results.push(`DELETE: ${path.relative(cwd, uriToFile(change.uri))}`);
						break;
				}
			}
		}
	}

	return results;
}

export function formatTextEdit(edit: TextEdit, maxLength = 50): string {
	const range = `${edit.range.start.line + 1}:${edit.range.start.character + 1}`;
	const preview =
		edit.newText.length > maxLength
			? `${edit.newText.slice(0, maxLength).replace(/\n/g, "\\n")}…`
			: edit.newText.replace(/\n/g, "\\n");
	return `line ${range} -> "${preview}"`;
}

// =============================================================================
// Symbol Formatting
// =============================================================================

const SYMBOL_KIND_LABELS: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

export function symbolKindToIcon(kind: SymbolKind): string {
	return `[${SYMBOL_KIND_LABELS[kind] ?? "?"}]`;
}

export function symbolKindToName(kind: SymbolKind): string {
	return SYMBOL_KIND_LABELS[kind] ?? "Unknown";
}

export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string[] {
	const prefix = "  ".repeat(indent);
	const icon = symbolKindToIcon(symbol.kind);
	const line = symbol.range.start.line + 1;
	const detail = symbol.detail ? ` ${symbol.detail}` : "";
	const results = [`${prefix}${icon} ${symbol.name}${detail} @ line ${line}`];

	if (symbol.children) {
		for (const child of symbol.children) {
			results.push(...formatDocumentSymbol(child, indent + 1));
		}
	}

	return results;
}

export function formatSymbolInformation(symbol: SymbolInformation, cwd: string): string {
	const icon = symbolKindToIcon(symbol.kind);
	const location = formatLocation(symbol.location, cwd);
	const container = symbol.containerName ? ` (${symbol.containerName})` : "";
	return `${icon} ${symbol.name}${container} @ ${location}`;
}

export function filterWorkspaceSymbols(symbols: SymbolInformation[], query: string): SymbolInformation[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return symbols;
	return symbols.filter(symbol => {
		const fields = [symbol.name, symbol.containerName ?? "", uriToFile(symbol.location.uri)];
		return fields.some(field => field.toLowerCase().includes(needle));
	});
}

export function dedupeWorkspaceSymbols(symbols: SymbolInformation[]): SymbolInformation[] {
	const seen = new Set<string>();
	const unique: SymbolInformation[] = [];
	for (const symbol of symbols) {
		const key = [
			symbol.name,
			symbol.containerName ?? "",
			symbol.kind,
			symbol.location.uri,
			symbol.location.range.start.line,
			symbol.location.range.start.character,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(symbol);
	}
	return unique;
}

export function formatCodeAction(action: CodeAction | Command, index: number): string {
	const kind = "kind" in action && action.kind ? action.kind : "action";
	const preferred = "isPreferred" in action && action.isPreferred ? " (preferred)" : "";
	const disabled = "disabled" in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : "";
	return `${index}: [${kind}] ${action.title}${preferred}${disabled}`;
}

export interface CodeActionApplyDependencies {
	resolveCodeAction?: (action: CodeAction) => Promise<CodeAction>;
	applyWorkspaceEdit: (edit: WorkspaceEdit) => Promise<string[]>;
	executeCommand: (command: Command) => Promise<void>;
}

export interface AppliedCodeActionResult {
	title: string;
	edits: string[];
	executedCommands: string[];
}

function isCommandItem(action: CodeAction | Command): action is Command {
	return typeof action.command === "string";
}

export async function applyCodeAction(
	action: CodeAction | Command,
	dependencies: CodeActionApplyDependencies,
): Promise<AppliedCodeActionResult | null> {
	if (isCommandItem(action)) {
		await dependencies.executeCommand(action);
		return { title: action.title, edits: [], executedCommands: [action.command] };
	}

	let resolvedAction = action;
	if (!resolvedAction.edit && dependencies.resolveCodeAction) {
		try {
			resolvedAction = await dependencies.resolveCodeAction(resolvedAction);
		} catch {
			// Resolve is optional; continue with unresolved action.
		}
	}

	const edits = resolvedAction.edit ? await dependencies.applyWorkspaceEdit(resolvedAction.edit) : [];
	const executedCommands: string[] = [];
	if (resolvedAction.command) {
		await dependencies.executeCommand(resolvedAction.command);
		executedCommands.push(resolvedAction.command.command);
	}

	if (edits.length === 0 && executedCommands.length === 0) {
		return null;
	}

	return { title: resolvedAction.title, edits, executedCommands };
}

const GLOB_PATTERN_CHARS = /[*?[{]/;

export function hasGlobPattern(value: string): boolean {
	return GLOB_PATTERN_CHARS.test(value);
}

export async function collectGlobMatches(
	pattern: string,
	cwd: string,
	maxMatches: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	const normalizedLimit = Number.isFinite(maxMatches) ? Math.max(1, Math.trunc(maxMatches)) : 1;
	const allMatches = await glob(pattern, { cwd });
	if (allMatches.length > normalizedLimit) {
		return { matches: allMatches.slice(0, normalizedLimit), truncated: true };
	}
	return { matches: allMatches, truncated: false };
}

// =============================================================================
// Hover Content Extraction
// =============================================================================

export function extractHoverText(
	contents: string | { kind: string; value: string } | { language: string; value: string } | unknown[],
): string {
	if (typeof contents === "string") {
		return contents;
	}

	if (Array.isArray(contents)) {
		return contents.map(c => extractHoverText(c as string | { kind: string; value: string })).join("\n\n");
	}

	if (typeof contents === "object" && contents !== null) {
		if ("value" in contents && typeof contents.value === "string") {
			return contents.value;
		}
	}

	return String(contents);
}

// =============================================================================
// General Utilities
// =============================================================================

function firstNonWhitespaceColumn(lineText: string): number {
	const match = lineText.match(/\S/);
	return match ? (match.index ?? 0) : 0;
}

function findSymbolMatchIndexes(lineText: string, symbol: string, caseInsensitive = false): number[] {
	if (symbol.length === 0) return [];
	const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
	const needle = caseInsensitive ? symbol.toLowerCase() : symbol;
	const indexes: number[] = [];
	let fromIndex = 0;
	while (fromIndex <= haystack.length - needle.length) {
		const matchIndex = haystack.indexOf(needle, fromIndex);
		if (matchIndex === -1) break;
		indexes.push(matchIndex);
		fromIndex = matchIndex + needle.length;
	}
	return indexes;
}

function normalizeOccurrence(occurrence?: number): number {
	if (occurrence === undefined || !Number.isFinite(occurrence)) return 1;
	return Math.max(1, Math.trunc(occurrence));
}

export async function resolveSymbolColumn(
	filePath: string,
	line: number,
	symbol?: string,
	occurrence?: number,
): Promise<number> {
	const lineNumber = Math.max(1, line);
	const matchOccurrence = normalizeOccurrence(occurrence);
	try {
		const fileText = await fsPromises.readFile(filePath, "utf-8");
		const lines = fileText.split("\n");
		const targetLine = lines[lineNumber - 1] ?? "";
		if (!symbol) {
			return firstNonWhitespaceColumn(targetLine);
		}

		const exactIndexes = findSymbolMatchIndexes(targetLine, symbol);
		const fallbackIndexes = exactIndexes.length > 0 ? exactIndexes : findSymbolMatchIndexes(targetLine, symbol, true);
		if (fallbackIndexes.length === 0) {
			throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}`);
		}
		if (matchOccurrence > fallbackIndexes.length) {
			throw new Error(
				`Symbol "${symbol}" occurrence ${matchOccurrence} is out of bounds on line ${lineNumber} (found ${fallbackIndexes.length})`,
			);
		}
		return fallbackIndexes[matchOccurrence - 1];
	} catch (error: unknown) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${filePath}`);
		}
		throw error;
	}
}

export async function readLocationContext(filePath: string, line: number, contextLines = 1): Promise<string[]> {
	const targetLine = Math.max(1, line);
	const surrounding = Math.max(0, contextLines);
	try {
		const fileText = await fsPromises.readFile(filePath, "utf-8");
		const lines = fileText.split("\n");
		if (lines.length === 0) return [];

		const startLine = Math.max(1, targetLine - surrounding);
		const endLine = Math.min(lines.length, targetLine + surrounding);
		const context: string[] = [];
		for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
			const content = lines[currentLine - 1] ?? "";
			context.push(`${currentLine}: ${content}`);
		}
		return context;
	} catch (error: unknown) {
		if (isEnoent(error)) {
			return [];
		}
		throw error;
	}
}

// =============================================================================
// Call Hierarchy Formatting
// =============================================================================

export function formatCallHierarchyItem(item: CallHierarchyItem, cwd: string): string {
	const icon = symbolKindToIcon(item.kind);
	const detail = item.detail ? ` ${item.detail}` : "";
	const relPath = path.relative(cwd, uriToFile(item.uri));
	const line = item.selectionRange.start.line + 1;
	return `${icon} ${item.name}${detail} @ ${relPath}:${line}`;
}

// =============================================================================
// Signature Help Formatting
// =============================================================================

function extractDocText(doc: string | MarkupContent | undefined): string {
	if (!doc) return "";
	if (typeof doc === "string") return doc;
	return doc.value;
}

export function formatSignatureHelp(result: SignatureHelp): string {
	if (!result.signatures || result.signatures.length === 0) {
		return "No signature information";
	}

	const activeIdx = result.activeSignature ?? 0;
	const sig = result.signatures[activeIdx] ?? result.signatures[0];
	const activeParam = result.activeParameter ?? sig.activeParameter;

	const lines: string[] = [sig.label];

	const sigDoc = extractDocText(sig.documentation);
	if (sigDoc) {
		lines.push("", sigDoc);
	}

	if (sig.parameters && sig.parameters.length > 0) {
		lines.push("", "Parameters:");
		for (let i = 0; i < sig.parameters.length; i++) {
			const p = sig.parameters[i];
			const label = typeof p.label === "string" ? p.label : sig.label.slice(p.label[0], p.label[1]);
			const active = i === activeParam ? " <-- active" : "";
			const doc = extractDocText(p.documentation);
			const docSuffix = doc ? ` — ${doc}` : "";
			lines.push(`  ${label}${docSuffix}${active}`);
		}
	}

	return lines.join("\n");
}
