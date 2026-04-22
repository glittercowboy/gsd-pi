import {
	Box,
	Container,
	getCapabilities,
	Image,
	type ImageDimensions,
	imageFallback,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import type { ToolDefinition } from "@gsd/agent-types";
import type { EditDiffError, EditDiffResult } from "@gsd/agent-types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@gsd/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@gsd/pi-coding-agent";
import { allTools, computeEditDiff, convertToPng, sanitizeBinaryOutput } from "../../../pi-coding-agent-compat.js";
import { theme } from "../../../theme.js";
import { shortenPath } from "../utils/shorten-path.js";
import { renderDiff } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
// During partial write tool-call streaming, re-highlight the first N lines fully
// to keep multiline tokenization mostly correct without re-highlighting the full file.
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

/**
 * Normalize control characters for terminal preview rendering.
 * Keep tool arguments unchanged, sanitize only display text.
 */
function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/** Safely coerce value to string for display. Returns null if invalid type. */
function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null; // Invalid type
}

/**
 * Split a Claude Code MCP tool name (`mcp__<server>__<tool>`) into its parts.
 * Returns null for non-prefixed names. Duplicated from the claude-code-cli
 * extension (parseMcpToolName) so this package doesn't have to import across
 * the resources/extensions boundary.
 */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice("mcp__".length);
	const delim = rest.indexOf("__");
	if (delim <= 0 || delim === rest.length - 2) return null;
	return { server: rest.slice(0, delim), tool: rest.slice(delim + 2) };
}

const COMPACT_ARG_VALUE_LIMIT = 60;
const GENERIC_OUTPUT_PREVIEW_LINES = 10;
const GENERIC_ARGS_JSON_PREVIEW_LINES = 10;

/**
 * Format tool args for the generic-renderer fallback. Produces a one-line
 * `k=v, k=v` summary when every value is a primitive that fits inline; falls
 * back to a truncated JSON dump for structurally complex args.
 */
function formatCompactArgs(args: unknown, expanded: boolean): string {
	if (args == null) return "";
	if (typeof args !== "object") return String(args);

	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return "";

	const allPrimitive = entries.every(([, value]) => {
		const t = typeof value;
		if (t === "number" || t === "boolean") return true;
		if (t === "string") return (value as string).length <= COMPACT_ARG_VALUE_LIMIT;
		return value == null;
	});

	if (allPrimitive) {
		return entries
			.map(([key, value]) => {
				if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
				if (value == null) return `${key}=null`;
				return `${key}=${String(value)}`;
			})
			.join(", ");
	}

	// Complex args: show truncated JSON.
	const lines = JSON.stringify(args, null, 2).split("\n");
	const maxLines = expanded ? lines.length : GENERIC_ARGS_JSON_PREVIEW_LINES;
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(0, maxLines).join("\n") + "\n...";
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

type ToolTruncationDetails = {
	truncated?: boolean;
	truncatedBy?: string;
	outputLines?: number;
	totalLines?: number;
	maxBytes?: number;
	maxLines?: number;
	firstLineExceedsLimit?: boolean;
};

type ToolResultDetails = {
	truncation?: ToolTruncationDetails;
	fullOutputPath?: string;
	firstChangedLine?: number;
	diff?: string;
	entryLimitReached?: number;
	resultLimitReached?: number;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	[key: string]: unknown;
};

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools (with its own padding/bg)
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private args: Record<string, unknown>;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private toolDefinition?: ToolDefinition;
	private ui: TUI;
	private cwd: string;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: ToolResultDetails;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Cached resolved image dimensions to avoid re-triggering async parsing
	// when updateDisplay() recreates Image components (#3455).
	private resolvedImageDimensions: Map<number, ImageDimensions> = new Map();
	// Incremental syntax highlighting cache for write tool call args
	private writeHighlightCache?: WriteHighlightCache;
	// When true, this component intentionally renders no lines
	private hideComponent = false;

	private get normalizedToolName(): string {
		return typeof this.toolName === "string" ? this.toolName.toLowerCase() : "";
	}

	constructor(
		toolName: string,
		args: Record<string, unknown>,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.toolDefinition = toolDefinition;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both - contentBox for custom tools/bash, contentText for other built-ins
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));

		// Use contentBox for bash (visual truncation) or custom tools with custom renderers
		// Use contentText for built-in tools (including overrides without custom renderers)
		if (this.normalizedToolName === "bash" || (toolDefinition && !this.shouldUseBuiltInRenderer())) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	/**
	 * Check if we should use built-in rendering for this tool.
	 * Returns true if the tool name is a built-in AND either there's no toolDefinition
	 * or the toolDefinition doesn't provide custom renderers.
	 */
	private shouldUseBuiltInRenderer(): boolean {
		const normalizedToolName = this.normalizedToolName;
		const isBuiltInName = normalizedToolName in allTools;
		const hasCustomRenderers = this.toolDefinition?.renderCall || this.toolDefinition?.renderResult;
		return isBuiltInName && !hasCustomRenderers;
	}

	dispose(): void {
		this.convertedImages.clear();
		this.imageComponents = [];
		this.imageSpacers = [];
		this.editDiffPreview = undefined;
		this.writeHighlightCache = undefined;
		this.result = undefined;
	}

	updateArgs(args: Record<string, unknown>): void {
		this.args = args;
		if (this.normalizedToolName === "write" && this.isPartial) {
			this.updateWriteHighlightCacheIncremental();
		}
		this.updateDisplay();
	}

	private highlightSingleLine(line: string, lang: string): string {
		const highlighted = highlightCode(line, lang);
		return highlighted[0] ?? "";
	}

	private refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
		const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
		if (prefixCount === 0) return;

		const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
		const prefixHighlighted = highlightCode(prefixSource, cache.lang);
		for (let i = 0; i < prefixCount; i++) {
			cache.highlightedLines[i] =
				prefixHighlighted[i] ?? this.highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
		}
	}

	private rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): void {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		const displayContent = normalizeDisplayText(fileContent);
		const normalized = replaceTabs(displayContent);
		this.writeHighlightCache = {
			rawPath,
			lang,
			rawContent: fileContent,
			normalizedLines: normalized.split("\n"),
			highlightedLines: highlightCode(normalized, lang),
		};
	}

	private updateWriteHighlightCacheIncremental(): void {
		const rawPath = str(this.args?.file_path ?? this.args?.path);
		const fileContent = str(this.args?.content);
		if (rawPath === null || fileContent === null) {
			this.writeHighlightCache = undefined;
			return;
		}

		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		if (!this.writeHighlightCache) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		const cache = this.writeHighlightCache;
		if (cache.lang !== lang || cache.rawPath !== rawPath) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (!fileContent.startsWith(cache.rawContent)) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (fileContent.length === cache.rawContent.length) {
			return;
		}

		const deltaRaw = fileContent.slice(cache.rawContent.length);
		const deltaDisplay = normalizeDisplayText(deltaRaw);
		const deltaNormalized = replaceTabs(deltaDisplay);
		cache.rawContent = fileContent;

		if (cache.normalizedLines.length === 0) {
			cache.normalizedLines.push("");
			cache.highlightedLines.push("");
		}

		const segments = deltaNormalized.split("\n");
		const lastIndex = cache.normalizedLines.length - 1;
		cache.normalizedLines[lastIndex] += segments[0];
		cache.highlightedLines[lastIndex] = this.highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);

		for (let i = 1; i < segments.length; i++) {
			cache.normalizedLines.push(segments[i]);
			cache.highlightedLines.push(this.highlightSingleLine(segments[i], cache.lang));
		}

		this.refreshWriteHighlightPrefix(cache);
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		if (this.toolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 * Handles both single-edit format (oldText/newText) and multi-edit format (edits[]).
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = str(this.args?.path);

		if (!path) return;

		const oldText = this.args?.oldText;
		const newText = this.args?.newText;
		const edits = this.args?.edits;

		if (typeof oldText === "string" && typeof newText === "string") {
			// Single-edit path: oldText + newText at top level
			const argsKey = JSON.stringify({ path, oldText, newText });
			if (this.editDiffArgsKey === argsKey) return;
			this.editDiffArgsKey = argsKey;

			computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
				if (this.editDiffArgsKey === argsKey) {
					this.editDiffPreview = result;
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		} else if (Array.isArray(edits)) {
			// Multi-edit path: edits[] array format
			// Validate each element has oldText and newText strings before passing to computeEditDiff
			const firstValidEdit = edits.find(
				(e): e is { oldText: string; newText: string } =>
					e !== null &&
					typeof e === "object" &&
					typeof e.oldText === "string" &&
					typeof e.newText === "string",
			);
			if (!firstValidEdit) return;

			const argsKey = JSON.stringify({ path, edits });
			if (this.editDiffArgsKey === argsKey) return;
			this.editDiffArgsKey = argsKey;

			// Preview the first edit; subsequent edits will be reflected in the post-execution diff
			computeEditDiff(path, firstValidEdit.oldText, firstValidEdit.newText, this.cwd).then((result) => {
				if (this.editDiffArgsKey === argsKey) {
					this.editDiffPreview = result;
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: ToolResultDetails;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (this.normalizedToolName === "write" && !isPartial) {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.maybeConvertImagesForKitty();
	}

	/**
	 * Mark a pending tool call as finished with no result (e.g., squashed by compaction).
	 * Stops the "Running" indicator without providing a result.
	 */
	markHistoricalNoResult(): void {
		this.isPartial = false;
		this.updateDisplay();
	}

	/**
	 * Finalize a pending tool call as failed/interrupted while preserving any streamed partial output.
	 */
	completeWithError(message?: string): void {
		this.isPartial = false;
		if (this.result) {
			let content = this.result.content;
			if (message) {
				const alreadyHasMessage = content.some((block) => block.type === "text" && block.text === message);
				if (!alreadyHasMessage) {
					content = [...content, { type: "text", text: message }];
				}
			}
			this.result = { ...this.result, content, isError: true };
		} else {
			this.result = {
				content: message ? [{ type: "text", text: message }] : [],
				isError: true,
			};
		}
		this.updateDisplay();
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		// Only needed for Kitty protocol
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			// Convert async
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		// Set background based on state
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		const useBuiltInRenderer = this.shouldUseBuiltInRenderer();
		let customRendererHasContent = false;
		this.hideComponent = false;

		// Use built-in rendering for built-in tools (or overrides without custom renderers)
		if (useBuiltInRenderer) {
			if (this.normalizedToolName === "bash") {
				// Bash uses Box with visual line truncation
				this.contentBox.setBgFn(bgFn);
				this.contentBox.clear();
				this.renderBashContent();
			} else {
				// Other built-in tools: use Text directly with caching
				this.contentText.setCustomBgFn(bgFn);
				this.contentText.setText(this.formatToolExecution());
			}
		} else if (this.toolDefinition) {
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			if (this.toolDefinition.renderCall) {
				try {
					const renderContext = {
						args: this.args,
						toolCallId: "",
						invalidate: () => this.updateDisplay(),
						lastComponent: undefined,
						state: undefined,
						cwd: this.cwd,
						executionStarted: !this.isPartial,
						argsComplete: true,
						isPartial: this.isPartial,
						expanded: this.expanded,
						showImages: this.showImages,
						isError: this.result?.isError ?? false,
					};
					// vendor-seam: dual-module-path -- ToolDefinition.renderCall signature diverges between pi dist and GSD usage
				const callComponent = (this.toolDefinition.renderCall as unknown as (...a: unknown[]) => Container | undefined)(this.args, theme, renderContext);
					if (callComponent !== undefined) {
						this.contentBox.addChild(callComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
					customRendererHasContent = true;
				}
			} else {
				// No custom renderCall, show tool name
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
				customRendererHasContent = true;
			}

			// Render result component if we have a result
			if (this.result && this.toolDefinition.renderResult) {
				try {
					const renderContext = {
						args: this.args,
						toolCallId: "",
						invalidate: () => this.updateDisplay(),
						lastComponent: undefined,
						state: undefined,
						cwd: this.cwd,
						executionStarted: true,
						argsComplete: true,
						isPartial: this.isPartial,
						expanded: this.expanded,
						showImages: this.showImages,
						isError: this.result.isError,
					};
					// vendor-seam: dual-module-path -- ToolDefinition.renderResult signature diverges between pi dist and GSD usage
					const resultComponent = (this.toolDefinition.renderResult as unknown as (...a: unknown[]) => Container | undefined)(
						{ content: this.result.content, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						renderContext,
					);
					if (resultComponent !== undefined) {
						this.contentBox.addChild(resultComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
						customRendererHasContent = true;
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					customRendererHasContent = true;
				}
			}
		} else {
			// Unknown tool with no registered definition - show generic fallback
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];
			const caps = getCapabilities();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (caps.images === "kitty" && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					// Pass cached dimensions to avoid re-triggering async parsing
					// when updateDisplay() recreates Image components (#3455).
					const cachedDims = this.resolvedImageDimensions.get(i);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
						cachedDims,
					);
					// setOnDimensionsResolved/getDimensions removed in pi-tui 0.67.2 —
					// dimensions are passed to the Image constructor and resolved synchronously.
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (!useBuiltInRenderer && this.toolDefinition) {
			this.hideComponent = !customRendererHasContent && this.imageComponents.length === 0;
		}
	}

	/**
	 * Render bash content using visual line truncation (like bash-execution.ts)
	 */
	private renderBashContent(): void {
		const command = str(this.args?.command);
		const timeout = this.args?.timeout as number | undefined;

		// Header
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		const commandDisplay =
			command === null ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
		this.contentBox.addChild(
			new Text(theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix, 0, 0),
		);

		if (this.result) {
			const output = this.getTextOutput().trim();

			if (output) {
				// Style each line for the output
				const styledOutput = output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					// Show all lines when expanded
					this.contentBox.addChild(new Text(`\n${styledOutput}`, 0, 0));
				} else {
					// Use visual line truncation when collapsed with width-aware caching
					let cachedWidth: number | undefined;
					let cachedLines: string[] | undefined;
					let cachedSkipped: number | undefined;

					this.contentBox.addChild({
						render: (width: number) => {
							if (cachedLines === undefined || cachedWidth !== width) {
								const result = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
								cachedLines = result.visualLines;
								cachedSkipped = result.skippedCount;
								cachedWidth = width;
							}
							if (cachedSkipped && cachedSkipped > 0) {
								const hint =
									theme.fg("muted", `... (${cachedSkipped} earlier lines,`) +
									` ${keyHint("expandTools", "to expand")})`;
								return ["", truncateToWidth(hint, width, "..."), ...cachedLines];
							}
							// Add blank line for spacing (matches expanded case)
							return ["", ...cachedLines];
						},
						invalidate: () => {
							cachedWidth = undefined;
							cachedLines = undefined;
							cachedSkipped = undefined;
						},
					});
				}
			}

			// Truncation warnings
			const truncation = this.result.details?.truncation;
			const fullOutputPath = this.result.details?.fullOutputPath;
			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
						);
					}
				}
				this.contentBox.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
			}
		}
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];

		let output = textBlocks
			.map((c) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
			if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
				const imageIndicators = imageBlocks
					.map((img) => {
						return imageFallback(typeof img.mimeType === "string" ? img.mimeType : "image/unknown");
					})
					.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text: string;
		const invalidArg = theme.fg("error", "[invalid arg]");
		const normalizedToolName = this.normalizedToolName;

		if (normalizedToolName === "read") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath) : null;
			const offset = typeof this.args?.offset === "number" ? this.args.offset : undefined;
			const limit = typeof this.args?.limit === "number" ? this.args.limit : undefined;

			let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "read failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const rawOutput = this.getTextOutput();
				// Strip hashline prefixes (e.g. "1#BQ:content") for TUI display
				const output = rawOutput.replace(/^(\s*)\d+#[ZPMQVRWSNKTXJBYH]{2}:/gm, "$1");
				const rawPath = str(this.args?.file_path ?? this.args?.path);
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
				const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
				}

				const truncation = this.result.details?.truncation;
				if (truncation?.truncated) {
					if (truncation.firstLineExceedsLimit) {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
							);
					} else if (truncation.truncatedBy === "lines") {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
							);
					} else {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
							);
					}
				}
			}
		} else if (normalizedToolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			const path = rawPath !== null ? shortenPath(rawPath) : null;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "..."));

			if (fileContent === null) {
				text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
			} else if (fileContent) {
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;

				let lines: string[];
				if (lang) {
					const cache = this.writeHighlightCache;
					if (cache && cache.lang === lang && cache.rawPath === rawPath && cache.rawContent === fileContent) {
						lines = cache.highlightedLines;
					} else {
						const displayContent = normalizeDisplayText(fileContent);
						const normalized = replaceTabs(displayContent);
						lines = highlightCode(normalized, lang);
						this.writeHighlightCache = {
							rawPath,
							lang,
							rawContent: fileContent,
							normalizedLines: normalized.split("\n"),
							highlightedLines: lines,
						};
					}
				} else {
					lines = normalizeDisplayText(fileContent).split("\n");
					this.writeHighlightCache = undefined;
				}

				const totalLines = lines.length;
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
						` ${keyHint("expandTools", "to expand")})`;
				}
			}

			// Show error if tool execution failed
			if (this.result?.isError) {
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			}
		} else if (normalizedToolName === "edit") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath) : null;

			// Build path display, appending :line if we have diff info
			let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const firstChangedLine =
				(this.editDiffPreview && "firstChangedLine" in this.editDiffPreview
					? this.editDiffPreview.firstChangedLine
					: undefined) ||
				(this.result && !this.result.isError ? this.result.details?.firstChangedLine : undefined);
			if (firstChangedLine) {
				pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

			if (this.result?.isError) {
				// Show error from result
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			} else if (this.result?.details?.diff) {
				// Tool executed successfully - use the diff from result
				// This takes priority over editDiffPreview which may have a stale error
				// due to race condition (async preview computed after file was modified)
				text += `\n\n${renderDiff(this.result.details.diff, { filePath: rawPath ?? undefined })}`;
			} else if (this.editDiffPreview) {
				// Use cached diff preview (before tool executes)
				if ("error" in this.editDiffPreview) {
					text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
				} else if (this.editDiffPreview.diff) {
					text += `\n\n${renderDiff(this.editDiffPreview.diff, { filePath: rawPath ?? undefined })}`;
				}
			}
		} else if (normalizedToolName === "ls") {
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const limit = this.args?.limit;

			text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "ls failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const entryLimit = this.result.details?.entryLimitReached;
				const truncation = this.result.details?.truncation;
				if (entryLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (entryLimit) {
						warnings.push(`${entryLimit} entries limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (normalizedToolName === "find") {
			const pattern = str(this.args?.pattern);
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("find")) +
				" " +
				(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
				theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "find failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const resultLimit = this.result.details?.resultLimitReached;
				const truncation = this.result.details?.truncation;
				if (resultLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (resultLimit) {
						warnings.push(`${resultLimit} results limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (normalizedToolName === "grep") {
			const pattern = str(this.args?.pattern);
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const glob = str(this.args?.glob);
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
				theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			if (this.result) {
				if (this.result.isError) {
					const errorText = this.getTextOutput().trim() || "grep failed";
					text += `\n\n${theme.fg("error", errorText)}`;
					return text;
				}

				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 15;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const matchLimit = this.result.details?.matchLimitReached;
				const truncation = this.result.details?.truncation;
				const linesTruncated = this.result.details?.linesTruncated;
				if (matchLimit || truncation?.truncated || linesTruncated) {
					const warnings: string[] = [];
					if (matchLimit) {
						warnings.push(`${matchLimit} matches limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					if (linesTruncated) {
						warnings.push("some lines truncated");
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (normalizedToolName === "web_search") {
			// Server-side Anthropic web search
			text = theme.fg("toolTitle", theme.bold("web search"));

			if (process.env.PI_OFFLINE === "1") {
				text += "\n\n" + theme.fg("muted", "\u{1F50C} Offline \u{2014} web search unavailable");
			} else if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 10;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}
			}
		} else {
			// Generic tool / MCP tool without a registered renderer.
			// MCP tool names from Claude Code arrive as `mcp__<server>__<tool>`;
			// render the server prefix in muted style so the tool name reads
			// cleanly. GSD-registered MCP tools have already had their prefix
			// stripped upstream in partial-builder.ts and won't reach this branch.
			const parsed = parseMcpToolName(this.toolName);
			const displayName = parsed ? parsed.tool : this.toolName;
			const serverPrefix = parsed ? theme.fg("muted", `${parsed.server}\u00b7`) : "";
			text = serverPrefix + theme.fg("toolTitle", theme.bold(displayName));

			const argsText = formatCompactArgs(this.args, this.expanded);
			if (argsText) {
				if (argsText.includes("\n")) {
					text += `\n\n${theme.fg("toolOutput", argsText)}`;
				} else {
					text += " " + theme.fg("toolOutput", argsText);
				}
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : GENERIC_OUTPUT_PREVIEW_LINES;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;
					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}
			}
		}

		return text;
	}
}
