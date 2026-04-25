/**
 * Stream adapter: bridges the Claude Agent SDK into GSD's streamSimple contract.
 *
 * The SDK runs the full agentic loop (multi-turn, tool execution, compaction)
 * in one call. This adapter translates the SDK's streaming output into
 * AssistantMessageEvents for TUI rendering, then preserves externally executed
 * tool-call blocks on the final AssistantMessage so Agent Core can render them
 * while `externalToolExecution` prevents local redispatch.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	ToolCall,
} from "@gsd/pi-ai";
import type { ExtensionUIContext } from "@gsd/pi-coding-agent";
import { EventStream } from "@gsd/pi-ai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage } from "./partial-builder.js";
import { buildWorkflowMcpServers } from "../gsd/workflow-mcp.js";
import { showInterviewRound, type Question, type RoundResult } from "../shared/tui.js";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "./sdk-types.js";

/** A single content block returned by an external (SDK-executed) tool call. */
export interface ExternalToolResultContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** The full result payload returned by an external tool, including content blocks and error status. */
export interface ExternalToolResultPayload {
	content: ExternalToolResultContentBlock[];
	details?: Record<string, unknown>;
	isError: boolean;
}

/** A `ToolCall` block augmented with the external result attached by the SDK synthetic user message. */
type ToolCallWithExternalResult = ToolCall & {
	externalResult?: ExternalToolResultPayload;
};

/** `SimpleStreamOptions` extended with an optional extension UI context for elicitation dialogs. */
interface ClaudeCodeStreamOptions extends SimpleStreamOptions {
	extensionUIContext?: ExtensionUIContext;
}

/** A single selectable option within an SDK elicitation schema field. */
interface SdkElicitationRequestOption {
	const?: string;
	title?: string;
}

/** JSON-Schema-like descriptor for a single field within an SDK elicitation request schema. */
interface SdkElicitationFieldSchema {
	type?: string;
	title?: string;
	description?: string;
	format?: string;
	writeOnly?: boolean;
	oneOf?: SdkElicitationRequestOption[];
	items?: {
		anyOf?: SdkElicitationRequestOption[];
	};
}

/** The full elicitation request object received from an MCP server via the Claude Agent SDK. */
interface SdkElicitationRequest {
	serverName: string;
	message: string;
	mode?: "form" | "url";
	requestedSchema?: {
		type?: string;
		properties?: Record<string, SdkElicitationFieldSchema>;
		required?: string[];
	};
}

/** The result returned by an elicitation handler back to the Claude Agent SDK. */
interface SdkElicitationResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, string | string[]>;
}

/** A TUI `Question` extended with an optional note-field ID for "None of the above" free-text capture. */
interface ParsedElicitationQuestion extends Question {
	noteFieldId?: string;
}

/** Descriptor for a single free-text input field parsed from an SDK elicitation form schema. */
interface ParsedTextInputField {
	id: string;
	title: string;
	description: string;
	required: boolean;
	secure: boolean;
}

/** A base64-encoded image block in the format accepted by the Claude Agent SDK input message. */
interface SDKInputImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

/** A plain-text block in the format accepted by the Claude Agent SDK input message. */
interface SDKInputTextBlock {
	type: "text";
	text: string;
}

/** Union of content block types that may appear in a Claude Agent SDK user input message. */
type SDKInputUserContentBlock = SDKInputImageBlock | SDKInputTextBlock;

/** A synthetic user message in the Claude Agent SDK's async-iterable prompt format, used when images are present. */
interface SDKInputUserMessage {
	type: "user";
	message: {
		role: "user";
		content: SDKInputUserContentBlock[];
	};
	parent_tool_use_id: null;
}

/** Label used for the free-text fallback option in single-choice elicitation questions. */
const OTHER_OPTION_LABEL = "None of the above";
/** Regex pattern that identifies field names and descriptions that should be treated as sensitive/secure inputs. */
const SENSITIVE_FIELD_PATTERN = /(password|passphrase|secret|token|api[_\s-]*key|private[_\s-]*key|credential)/i;

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

/**
 * Construct an AssistantMessageEventStream using EventStream directly.
 * (The class itself is only re-exported as a type from the @gsd/pi-ai barrel.)
 */
function createAssistantStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

/** Extract a human-readable error string from an SDK result message. */
export function getResultErrorMessage(result: SDKResultMessage): string {
	if ("errors" in result && Array.isArray(result.errors) && result.errors.length > 0) {
		return result.errors.join("; ");
	}

	if ("result" in result && typeof result.result === "string" && result.result.trim().length > 0) {
		return result.result.trim();
	}

	return result.subtype === "success" ? "claude_code_request_failed" : result.subtype;
}

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

/** Cached result of the Claude executable/script resolution so lookup runs once per process. */
let cachedClaudePath: string | null = null;
const requireFromHere = createRequire(import.meta.url);

/** Return the shell command used to locate the `claude` binary on the given platform. */
export function getClaudeLookupCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "where claude" : "which claude";
}

/**
 * Pick the most suitable path from `which`/`where` output.
 *
 * On Windows, `where claude` can return shim entries first (for example
 * `...\\npm\\claude` / `...\\npm\\claude.cmd`) that the Claude Agent SDK treats
 * as a native executable path and then fails to spawn. Prefer a native
 * `.exe` candidate when present.
 */
export function parseClaudeLookupOutput(output: Buffer | string, platform: NodeJS.Platform = process.platform): string {
	const lines = output
		.toString()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length === 0) return "";
	if (platform !== "win32") return lines[0] ?? "";

	const exeCandidate = lines.find((line) => /\.exe$/i.test(line));
	if (exeCandidate) return exeCandidate;

	const cmdCandidate = lines.find((line) => /\.cmd$/i.test(line));
	if (cmdCandidate) return cmdCandidate;

	return lines[0] ?? "";
}

/** Resolve the SDK-bundled cli.js path if available. */
export function resolveBundledClaudeCliPath(): string | null {
	try {
		const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
		const cliPath = join(dirname(sdkEntry), "cli.js");
		return existsSync(cliPath) ? cliPath : null;
	} catch {
		return null;
	}
}

/**
 * Normalize a discovered path for Claude Agent SDK consumption.
 *
 * On Windows, the SDK treats non-`.js` paths as native binaries. NPM shims
 * like `claude`/`claude.cmd` are not native binaries and can fail with
 * `ENOENT`/`EINVAL` in that mode. When no `.exe` is available, prefer the
 * SDK-bundled `cli.js` so the SDK runs via Node.
 */
export function normalizeClaudePathForSdk(
	resolvedPath: string,
	platform: NodeJS.Platform = process.platform,
	bundledCliPath: string | null = resolveBundledClaudeCliPath(),
): string {
	if (platform !== "win32") return resolvedPath;
	if (/\.exe$/i.test(resolvedPath)) return resolvedPath;
	if (bundledCliPath) return bundledCliPath;
	return resolvedPath;
}

/** Resolve the path passed to `pathToClaudeCodeExecutable`. */
function getClaudePath(): string {
	if (cachedClaudePath) return cachedClaudePath;

	const fallback = process.platform === "win32"
		? (resolveBundledClaudeCliPath() ?? "claude.cmd")
		: "claude";

	try {
		const lookupOutput = execSync(getClaudeLookupCommand(), { timeout: 5_000, stdio: "pipe" });
		const parsed = parseClaudeLookupOutput(lookupOutput, process.platform);
		cachedClaudePath = normalizeClaudePathForSdk(parsed || fallback, process.platform);
	} catch {
		cachedClaudePath = fallback;
	}

	return cachedClaudePath;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Extract text content from a single message regardless of content shape.
 */
function extractMessageText(msg: { role: string; content: unknown }): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		const textParts = msg.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text ?? part.thinking ?? "");
		if (textParts.length > 0) return textParts.join("\n");
	}
	return "";
}

/**
 * Build a full conversational prompt from GSD's context messages.
 *
 * Previous behaviour sent only the last user message, making every SDK
 * call effectively stateless. This version serialises the complete
 * conversation history (system prompt + all user/assistant turns) so
 * Claude Code has full context for multi-turn continuity.
 *
 * History is wrapped in XML-tag structure rather than `[User]`/`[Assistant]`
 * bracket headers. Bracket headers read to the model as an in-context
 * demonstration of how turns are delimited, causing it to fabricate fake
 * user turns in its own output. XML tags read as document structure and
 * don't get mirrored in free text.
 */
export function buildPromptFromContext(context: Context): string {
	const hasContent = Boolean(context.systemPrompt) || context.messages.some((m) => extractMessageText(m));
	if (!hasContent) return "";

	const parts: string[] = [
		"Respond only to the final user message below. " +
			"Do not emit <user_message>, <assistant_message>, or <prior_system_context> tags in your response.",
	];

	if (context.systemPrompt) {
		parts.push(`<prior_system_context>\n${context.systemPrompt}\n</prior_system_context>`);
	}

	const turns: string[] = [];
	for (const msg of context.messages) {
		const text = extractMessageText(msg);
		if (!text) continue;
		const tag =
			msg.role === "user" ? "user_message" : msg.role === "assistant" ? "assistant_message" : "system_message";
		turns.push(`<${tag}>\n${text}\n</${tag}>`);
	}
	if (turns.length > 0) {
		parts.push(`<conversation_history>\n${turns.join("\n")}\n</conversation_history>`);
	}

	return parts.join("\n\n");
}

/** Strip the `data:<mime>;base64,` prefix from a data URI, returning only the raw base64 payload. */
function stripDataUriPrefix(value: string): string {
	const commaIndex = value.indexOf(",");
	if (value.startsWith("data:") && commaIndex !== -1) {
		return value.slice(commaIndex + 1);
	}
	return value;
}

/** Extract the MIME type from a data URI string, or return `null` if the value is not a valid data URI. */
function inferMimeTypeFromDataUri(value: string): string | null {
	const match = /^data:([^;,]+);base64,/.exec(value);
	return match?.[1] ?? null;
}

/** Collect all base64 image blocks from user messages in the context for inclusion in the SDK prompt. */
export function extractImageBlocksFromContext(context: Context): SDKInputImageBlock[] {
	const imageBlocks: SDKInputImageBlock[] = [];

	for (const msg of context.messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const block = part as { type?: unknown; data?: unknown; mimeType?: unknown };
			if (block.type !== "image" || typeof block.data !== "string") continue;

			const mimeType =
				typeof block.mimeType === "string" && block.mimeType.length > 0
					? block.mimeType
					: inferMimeTypeFromDataUri(block.data);
			if (!mimeType) continue;

			imageBlocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: mimeType,
					data: stripDataUriPrefix(block.data),
				},
			});
		}
	}

	return imageBlocks;
}

/** Build the SDK query prompt, wrapping image blocks into an async iterable user message when present. */
export function buildSdkQueryPrompt(
	context: Context,
	textPrompt: string = buildPromptFromContext(context),
): string | AsyncIterable<SDKInputUserMessage> {
	const imageBlocks = extractImageBlocksFromContext(context);
	if (imageBlocks.length === 0) {
		return textPrompt;
	}

	const content: SDKInputUserContentBlock[] = [...imageBlocks];
	if (textPrompt) {
		content.push({ type: "text", text: textPrompt });
	}

	const sdkMessage: SDKInputUserMessage = {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
	};

	return (async function* () {
		yield sdkMessage;
	})();
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/** Build a minimal error `AssistantMessage` with the given model ID and error text. */
function makeErrorMessage(model: string, errorMsg: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Claude Code error: ${errorMsg}` }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: errorMsg,
		timestamp: Date.now(),
	};
}

/**
 * Generator exhaustion without a terminal result means the SDK stream was
 * interrupted mid-turn. Surface it as an error so downstream recovery logic
 * can classify and retry it instead of treating it as a clean completion.
 */
export function makeStreamExhaustedErrorMessage(model: string, lastTextContent: string): AssistantMessage {
	const errorMsg = "stream_exhausted_without_result";
	const message = makeErrorMessage(model, errorMsg);
	if (lastTextContent) {
		message.content = [{ type: "text", text: lastTextContent }];
	}
	return message;
}

/** Extract the string labels from an array of SDK elicitation option objects, filtering out blank entries. */
function readElicitationChoices(options: SdkElicitationRequestOption[] | undefined): string[] {
	if (!Array.isArray(options)) return [];
	return options
		.map((option) => (typeof option?.const === "string" ? option.const : typeof option?.title === "string" ? option.title : ""))
		.filter((option): option is string => option.length > 0);
}

/** Parse an SDK elicitation request into structured multiple-choice questions, or null if the schema is unsupported. */
export function parseAskUserQuestionsElicitation(
	request: Pick<SdkElicitationRequest, "mode" | "requestedSchema">,
): ParsedElicitationQuestion[] | null {
	if (request.mode && request.mode !== "form") return null;
	const properties = request.requestedSchema?.properties;
	if (!properties || typeof properties !== "object") return null;

	const questions: ParsedElicitationQuestion[] = [];

	for (const [fieldId, rawField] of Object.entries(properties)) {
		if (fieldId.endsWith("__note")) continue;
		if (!rawField || typeof rawField !== "object") return null;

		const header = typeof rawField.title === "string" && rawField.title.length > 0 ? rawField.title : fieldId;
		const question = typeof rawField.description === "string" ? rawField.description : "";

		if (rawField.type === "array") {
			const options = readElicitationChoices(rawField.items?.anyOf).map((label) => ({ label, description: "" }));
			if (options.length === 0) return null;
			questions.push({
				id: fieldId,
				header,
				question,
				options,
				allowMultiple: true,
			});
			continue;
		}

		if (rawField.type === "string") {
			const noteFieldId = Object.prototype.hasOwnProperty.call(properties, `${fieldId}__note`)
				? `${fieldId}__note`
				: undefined;
			const options = readElicitationChoices(rawField.oneOf)
				.filter((label) => label !== OTHER_OPTION_LABEL)
				.map((label) => ({ label, description: "" }));
			if (options.length === 0) return null;
			questions.push({
				id: fieldId,
				header,
				question,
				options,
				noteFieldId,
			});
			continue;
		}

		return null;
	}

	return questions.length > 0 ? questions : null;
}

/** Return true if the elicitation field should be treated as sensitive and rendered as a secure/password input. */
function isSecureElicitationField(
	requestMessage: string,
	fieldId: string,
	field: SdkElicitationFieldSchema,
): boolean {
	if (field.format === "password") return true;
	if (field.writeOnly === true) return true;

	const rawField = field as Record<string, unknown>;
	if (rawField.sensitive === true || rawField["x-sensitive"] === true) return true;

	const haystack = [
		requestMessage,
		fieldId.replace(/[_-]+/g, " "),
		typeof field.title === "string" ? field.title : "",
		typeof field.description === "string" ? field.description : "",
	]
		.join(" ")
		.toLowerCase();

	return SENSITIVE_FIELD_PATTERN.test(haystack);
}

/** Parse an SDK elicitation request into free-text input field descriptors, or null if unsupported. */
export function parseTextInputElicitation(
	request: Pick<SdkElicitationRequest, "message" | "mode" | "requestedSchema">,
): ParsedTextInputField[] | null {
	if (request.mode && request.mode !== "form") return null;
	const schema = request.requestedSchema as
		| ({ properties?: Record<string, SdkElicitationFieldSchema>; keys?: Record<string, SdkElicitationFieldSchema> } & Record<string, unknown>)
		| undefined;
	const fieldsSource = schema?.properties && typeof schema.properties === "object"
		? schema.properties
		: schema?.keys && typeof schema.keys === "object"
			? schema.keys
			: undefined;
	if (!fieldsSource) return null;

	const requiredSet = new Set(
		Array.isArray(request.requestedSchema?.required)
			? request.requestedSchema.required.filter((value): value is string => typeof value === "string")
			: [],
	);

	const fields: ParsedTextInputField[] = [];
	for (const [fieldId, field] of Object.entries(fieldsSource)) {
		if (!field || typeof field !== "object") continue;
		if (field.type !== "string") continue;
		if (Array.isArray(field.oneOf) && field.oneOf.length > 0) continue;

		fields.push({
			id: fieldId,
			title: typeof field.title === "string" && field.title.length > 0 ? field.title : fieldId,
			description: typeof field.description === "string" ? field.description : "",
			required: requiredSet.has(fieldId),
			secure: isSecureElicitationField(request.message, fieldId, field),
		});
	}

	return fields.length > 0 ? fields : null;
}

/** Convert a TUI interview round result into the SDK elicitation content map. */
export function roundResultToElicitationContent(
	questions: ParsedElicitationQuestion[],
	result: RoundResult,
): Record<string, string | string[]> {
	const content: Record<string, string | string[]> = {};

	for (const question of questions) {
		const answer = result.answers[question.id];
		if (!answer) continue;

		if (question.allowMultiple) {
			const selected = Array.isArray(answer.selected) ? answer.selected : [answer.selected];
			content[question.id] = selected;
			continue;
		}

		const selected = Array.isArray(answer.selected) ? answer.selected[0] ?? "" : answer.selected;
		content[question.id] = selected;
		if (question.noteFieldId && selected === OTHER_OPTION_LABEL && answer.notes.trim().length > 0) {
			content[question.noteFieldId] = answer.notes.trim();
		}
	}

	return content;
}

/** Build the dialog title string for a multiple-choice elicitation question, combining server name, header, and question text. */
function buildElicitationPromptTitle(request: SdkElicitationRequest, question: ParsedElicitationQuestion): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		question.header,
		question.question,
	].filter((part) => part && part.trim().length > 0);
	return parts.join("\n\n");
}

/** Drive each multiple-choice elicitation question through the extension UI's `select` dialog, collecting answers into an SDK result. */
async function promptElicitationWithDialogs(
	request: SdkElicitationRequest,
	questions: ParsedElicitationQuestion[],
	ui: ExtensionUIContext,
	signal: AbortSignal,
): Promise<SdkElicitationResult> {
	const content: Record<string, string | string[]> = {};

	for (const question of questions) {
		const title = buildElicitationPromptTitle(request, question);

		if (question.allowMultiple) {
			const selected = await ui.select(title, question.options.map((option) => option.label), {
				allowMultiple: true,
				signal,
			});
			if (Array.isArray(selected)) {
				if (selected.length === 0) return { action: "cancel" };
				content[question.id] = selected;
				continue;
			}
			if (typeof selected === "string" && selected.length > 0) {
				content[question.id] = [selected];
				continue;
			}
			return { action: "cancel" };
		}

		const selected = await ui.select(title, [...question.options.map((option) => option.label), OTHER_OPTION_LABEL], { signal });
		if (typeof selected !== "string" || selected.length === 0) {
			return { action: "cancel" };
		}

		content[question.id] = selected;
		if (question.noteFieldId && selected === OTHER_OPTION_LABEL) {
			const note = await ui.input(`${question.header} note`, "Explain your answer", { signal });
			if (note === undefined) return { action: "cancel" };
			if (note.trim().length > 0) {
				content[question.noteFieldId] = note.trim();
			}
		}
	}

	return { action: "accept", content };
}

/** Build the dialog title string for a free-text input field, combining server name, field title, and description. */
function buildTextInputPromptTitle(request: SdkElicitationRequest, field: ParsedTextInputField): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		field.title,
		field.description,
	].filter((part) => typeof part === "string" && part.trim().length > 0);
	return parts.join("\n\n");
}

/** Derive a placeholder hint for a free-text input field from its description, falling back to "Required" or "Leave empty to skip". */
function buildTextInputPlaceholder(field: ParsedTextInputField): string | undefined {
	const desc = field.description.trim();
	if (!desc) return field.required ? "Required" : "Leave empty to skip";

	const formatLine = desc
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => /^format:/i.test(line));

	if (!formatLine) return field.required ? "Required" : "Leave empty to skip";
	const hint = formatLine.replace(/^format:\s*/i, "").trim();
	return hint.length > 0 ? hint : field.required ? "Required" : "Leave empty to skip";
}

/** Collect each free-text input field via the extension UI's `input` dialog, returning the filled SDK elicitation result. */
async function promptTextInputElicitation(
	request: SdkElicitationRequest,
	fields: ParsedTextInputField[],
	ui: ExtensionUIContext,
	signal: AbortSignal,
): Promise<SdkElicitationResult> {
	const content: Record<string, string | string[]> = {};

	for (const field of fields) {
		const value = await ui.input(
			buildTextInputPromptTitle(request, field),
			buildTextInputPlaceholder(field),
			{ signal, ...(field.secure ? { secure: true } : {}) },
		);
		if (value === undefined) {
			return { action: "cancel" };
		}
		content[field.id] = value;
	}

	return { action: "accept", content };
}

// ---------------------------------------------------------------------------
// canUseTool handler
// ---------------------------------------------------------------------------

/** Options passed by the SDK to the canUseTool callback. */
interface CanUseToolOptions {
	signal: AbortSignal;
	suggestions?: Array<Record<string, unknown>>;
	blockedPath?: string;
	decisionReason?: string;
	title?: string;
	displayName?: string;
	description?: string;
	toolUseID: string;
	agentID?: string;
}

/** Result returned by the canUseTool callback to the SDK. */
type CanUseToolPermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: Array<Record<string, unknown>>; toolUseID?: string }
	| { behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string };

/**
 * Known CLI tools where the subcommand verb changes the risk profile.
 * Value = number of subcommand tokens (beyond the executable) to capture
 * in the "Always Allow" permission pattern.
 *
 * `git push` and `git log` are very different → depth 1 → `Bash(git push:*)`
 * `gh pr create` and `gh pr list` differ at depth 2 → `Bash(gh pr create:*)`
 * `ping` is always safe → not listed → `Bash(ping:*)`
 */
const SUBCOMMAND_DEPTH: Record<string, number> = {
	git: 1,
	gh: 2,
	npm: 1,
	npx: 1,
	yarn: 1,
	pnpm: 1,
	docker: 1,
	kubectl: 1,
	aws: 2,
	az: 2,
	gcloud: 2,
	cargo: 1,
	pip: 1,
	pip3: 1,
	brew: 1,
	terraform: 1,
	helm: 1,
	dotnet: 1,
};

/** Command wrappers to skip when extracting the base executable. */
const CMD_PASSTHROUGH = new Set(["sudo", "env", "command"]);

/**
 * Build a smart permission pattern for Bash "Always Allow".
 *
 * Simple commands → `Bash(ping:*)` (any args are fine)
 * Subcommand-sensitive CLIs → `Bash(git push:*)` (verb is captured, args wildcarded)
 */
export function buildBashPermissionPattern(command: string): string {
	// When the command is a chain like "cd /foo && gh pr list", extract the
	// last segment — `cd` is just setup, the meaningful operation is what follows.
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
	// Skip leading `cd` (directory setup) and trailing error suppressors
	// like `|| true`, `|| :`, `|| echo ...`.  The meaningful command is
	// the first segment that is *neither* of those.
	const SETUP_RE = /^\s*cd\s/;
	const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
	let meaningful: string | undefined;
	if (segments.length > 1) {
		// Strip suppressors, then strip cd prefixes; take the *last* remaining
		// segment — that's the meaningful command.
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s));
		const core = trimmed.filter(s => !SETUP_RE.test(s));
		meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
	}
	meaningful = meaningful || segments[0] || command;
	const rawTokens = meaningful.trim().split(/\s+/);

	// Skip sudo/env wrappers and leading VAR=val assignments
	let idx = 0;
	while (idx < rawTokens.length) {
		if (CMD_PASSTHROUGH.has(rawTokens[idx])) { idx++; continue; }
		if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) { idx++; continue; }
		break;
	}
	const tokens = rawTokens.slice(idx).filter(Boolean);
	if (tokens.length === 0) return "Bash(*)";

	// Strip path and .exe from executable name
	const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
	const depth = SUBCOMMAND_DEPTH[base];

	if (depth !== undefined) {
		// Capture base + N subcommand tokens: "gh pr list" → Bash(gh pr list:*)
		const significant = [base, ...tokens.slice(1, 1 + depth)].join(" ");
		return `Bash(${significant}:*)`;
	}

	// Simple command — any args are fine: "ping" → Bash(ping:*)
	return `Bash(${base}:*)`;
}

/**
 * Build the list of granularity options presented after a user chooses
 * "Always Allow" for a Bash command.
 *
 * Rather than assuming the user wants the default smart pattern, the UI
 * shows every meaningful prefix so the user explicitly picks the scope:
 *
 *   "gh pr list --limit 5" → [
 *     "Bash(gh:*)",         // allow any gh command
 *     "Bash(gh pr:*)",      // allow any gh pr subcommand
 *     "Bash(gh pr list:*)", // allow just this verb
 *   ]
 *
 * Flags (tokens starting with `-`) terminate the subcommand chain — they
 * are call-site arguments, not stable verbs. Subcommand depth is capped
 * at 3 to keep the menu short (max 4 options).
 *
 * Returns a single-entry list when there is no meaningful subcommand to
 * choose from (e.g. `ls -la`). Callers can skip the second dialog in
 * that case.
 */
export function buildBashPermissionPatternOptions(command: string): string[] {
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
	const SETUP_RE = /^\s*cd\s/;
	const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
	let meaningful: string | undefined;
	if (segments.length > 1) {
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s));
		const core = trimmed.filter(s => !SETUP_RE.test(s));
		meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
	}
	meaningful = meaningful || segments[0] || command;
	const rawTokens = meaningful.trim().split(/\s+/);

	let idx = 0;
	while (idx < rawTokens.length) {
		if (CMD_PASSTHROUGH.has(rawTokens[idx])) { idx++; continue; }
		if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) { idx++; continue; }
		break;
	}
	const tokens = rawTokens.slice(idx).filter(Boolean);
	if (tokens.length === 0) return ["Bash(*)"];

	const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

	// Collect up to 3 subcommand tokens, stopping at the first flag.
	const subTokens: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("-")) break;
		subTokens.push(t);
		if (subTokens.length >= 3) break;
	}

	const patterns: string[] = [`Bash(${base}:*)`];
	for (let i = 1; i <= subTokens.length; i++) {
		patterns.push(`Bash(${[base, ...subTokens.slice(0, i)].join(" ")}:*)`);
	}
	return patterns;
}

/**
 * Read Bash allow-rule patterns from project and user settings files.
 *
 * Returns the ruleContent portion (e.g. `"gh pr list:*"`) for each
 * `Bash(...)` entry found in `permissions.allow`.
 */
function readBashAllowRulesFromSettings(): string[] {
	const rules: string[] = [];
	const paths = [
		join(process.cwd(), ".claude", "settings.local.json"),
		join(process.cwd(), ".claude", "settings.json"),
	];
	try {
		paths.push(join(homedir(), ".claude", "settings.json"));
	} catch {
		// homedir() can throw on some platforms
	}
	for (const settingsPath of paths) {
		try {
			if (!existsSync(settingsPath)) continue;
			const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
			const allow = raw?.permissions?.allow;
			if (!Array.isArray(allow)) continue;
			for (const entry of allow) {
				if (typeof entry !== "string") continue;
				const m = /^Bash\((.+)\)$/.exec(entry);
				if (m) rules.push(m[1]);
			}
		} catch {
			// Ignore malformed settings files
		}
	}
	return rules;
}

/**
 * Check if a Bash compound command matches saved allow rules after
 * extracting the meaningful segment.
 *
 * The SDK's built-in matcher refuses to match prefix rules against
 * compound commands (e.g. `cd /path && gh pr list`). Claude Code
 * routinely prepends `cd <cwd> &&` to commands, causing saved rules
 * to never match on re-invocation. This function strips safe leading
 * segments (only `cd` commands) and checks the remaining operation
 * against saved rules.
 *
 * For compound commands, returns true only when all leading segments
 * are `cd` commands and the final segment matches a saved rule.
 * For simple (single-segment) commands, checks directly against saved
 * rules — this covers the case where a rule was added mid-session and
 * the SDK's in-memory cache is stale.
 */
export function bashCommandMatchesSavedRules(command: string): boolean {
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
	if (segments.length === 0) return false;

	let meaningful: string;
	if (segments.length === 1) {
		meaningful = segments[0].trim();
	} else {
		// Strip trailing error suppressors (|| true, || :, || echo ...)
		// and leading cd segments.  The first remaining segment is the
		// meaningful command.  All other non-cd, non-suppressor segments
		// must be absent — otherwise we can't safely auto-approve.
		const SETUP_RE = /^cd\s/;
		const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s.trim()));
		const core = trimmed.filter(s => !SETUP_RE.test(s.trim()));
		if (core.length !== 1) return false; // ambiguous — multiple real commands
		meaningful = core[0].trim();
	}
	if (!meaningful) return false;

	const rules = readBashAllowRulesFromSettings();
	if (rules.length === 0) return false;

	for (const rule of rules) {
		const prefixMatch = /^(.+):\*$/.exec(rule);
		if (prefixMatch) {
			const prefix = prefixMatch[1];
			if (meaningful === prefix || meaningful.startsWith(prefix + " ")) {
				return true;
			}
			continue;
		}
		// Exact match
		if (meaningful === rule) return true;
	}

	return false;
}

/** Format the tool input into a human-readable summary for the permission prompt. */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
	// Bash — show the command
	if (input.command && typeof input.command === "string") {
		const cmd = input.command.length > 300 ? input.command.slice(0, 300) + "…" : input.command;
		return cmd;
	}
	// File-oriented tools — show path
	if (input.file_path && typeof input.file_path === "string") {
		return `${toolName}: ${input.file_path}`;
	}
	// Generic fallback — compact JSON, truncated
	const json = JSON.stringify(input);
	if (json.length <= 200) return json;
	return json.slice(0, 200) + "…";
}

/**
 * Create a canUseTool handler that routes SDK permission requests through the
 * extension UI's select dialog, or auto-approves when no UI is available.
 *
 * Presents three options:
 * - **Allow** — approve this one invocation
 * - **Always Allow** — approve and pass `suggestions` back as `updatedPermissions`
 *   so the SDK remembers the choice for the rest of the session
 * - **Deny** — reject the invocation
 *
 * Follows the same pattern as {@link createClaudeCodeElicitationHandler}:
 * takes an optional UI context and returns the callback or undefined.
 *
 * When UI is unavailable (headless / auto-mode sub-agents), returns a handler
 * that always approves — replacing the old GSD_AUTO_MODE → bypassPermissions
 * workaround.
 */
export function createClaudeCodeCanUseToolHandler(
	ui: ExtensionUIContext | undefined,
): ((toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<CanUseToolPermissionResult>) | undefined {
	if (!ui) return undefined;

	return async (toolName, _input, options) => {
		// Abort early if the signal is already fired
		if (options.signal.aborted) {
			return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
		}

		// For Bash compound commands (e.g. "cd /path && gh pr list"),
		// check if the meaningful operation matches a saved allow rule.
		// The SDK's built-in matcher rejects prefix rules for compound
		// commands, but cd-prefixed commands are routine and the actual
		// operation is already approved.
		if (toolName === "Bash" && typeof _input.command === "string") {
			if (bashCommandMatchesSavedRules(_input.command)) {
				return { behavior: "allow", updatedInput: _input, toolUseID: options.toolUseID };
			}
		}

		const inputSummary = formatToolInput(toolName, _input);
		const title = options.title || `Allow Claude Code to use: ${toolName}?`;
		const body = [
			options.description,
			inputSummary,
		].filter(Boolean).join("\n");

		// The 2nd menu (level picker) lets the user choose the exact pattern,
		// so the 1st menu just shows "Always Allow" without a command suffix.
		const alwaysAllowLabel = "Always Allow";

		try {
			const choice = await ui.select(
				`${title}\n${body}`,
				["Allow", alwaysAllowLabel, "Deny"],
				{ signal: options.signal },
			);

			if (options.signal.aborted) {
				return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
			}

			if (choice === alwaysAllowLabel) {
				// Pass the SDK's own suggestions back as updatedPermissions so
				// it knows how to persist them (PermissionUpdate[] shape).
				// For Bash, patch the ruleContent with the user-chosen
				// granularity pattern (e.g. "gh", "gh pr", "gh pr list") so
				// the saved rule matches the scope the user actually wants.
				let perms = options.suggestions;
				let notifyLabel: string | undefined;
				if (toolName === "Bash" && typeof _input.command === "string") {
					// Present every meaningful prefix so the user picks the
					// scope explicitly rather than getting a blanket match.
					const patternOptions = buildBashPermissionPatternOptions(_input.command);
					let chosenPattern: string;
					if (patternOptions.length <= 1) {
						// No subcommand choice to make (e.g. "ls -la") — use
						// the single available pattern directly.
						chosenPattern = patternOptions[0] ?? buildBashPermissionPattern(_input.command);
					} else {
						const levelChoiceRaw = await ui.select(
							"Save permission at which level?",
							patternOptions,
							{ signal: options.signal },
						);
						if (options.signal.aborted) {
							return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
						}
						const levelChoice = Array.isArray(levelChoiceRaw) ? levelChoiceRaw[0] : levelChoiceRaw;
						if (!levelChoice || !patternOptions.includes(levelChoice)) {
							// User dismissed the level picker — cancel the
							// tool use. Falling back to a one-time allow
							// here would leave the spawned agent running
							// with no clear signal that the user bailed.
							return {
								behavior: "deny",
								message: "User cancelled permission selection",
								toolUseID: options.toolUseID,
							};
						}
						chosenPattern = levelChoice;
					}
					notifyLabel = chosenPattern;
					// Extract the ruleContent portion from "Bash(gh pr list:*)" → "gh pr list:*"
					const ruleContent = chosenPattern.replace(/^Bash\(/, "").replace(/\)$/, "");
					if (perms && Array.isArray(perms) && perms.length > 0) {
						// Clone suggestions and patch ruleContent on any Bash addRules entry
						perms = perms.map((s: any) => {
							if (s.type === "addRules" && Array.isArray(s.rules)) {
								return {
									...s,
									rules: s.rules.map((r: any) =>
										r.toolName === "Bash" ? { ...r, ruleContent } : r,
									),
								};
							}
							return s;
						});
					} else {
						// No suggestions from SDK — build a proper PermissionUpdate
						perms = [{
							type: "addRules",
							rules: [{ toolName: "Bash", ruleContent }],
							behavior: "allow",
							destination: "localSettings",
						}];
					}
				}
				// Notify with the resolved pattern (label already previewed it)
				if (notifyLabel) {
					ui.notify(`Saved: ${notifyLabel}`, "info");
				}
				return {
					behavior: "allow",
					updatedInput: _input,
					toolUseID: options.toolUseID,
					...(perms ? { updatedPermissions: perms } : {}),
				};
			}

			if (choice === "Allow") {
				return {
					behavior: "allow",
					updatedInput: _input,
					toolUseID: options.toolUseID,
				};
			}

			return { behavior: "deny", message: "User denied", toolUseID: options.toolUseID };
		} catch {
			return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
		}
	};
}

// ---------------------------------------------------------------------------
// Elicitation handler
// ---------------------------------------------------------------------------

/** Create an SDK elicitation handler that routes requests through the extension UI dialogs, or undefined if no UI is available. */
export function createClaudeCodeElicitationHandler(
	ui: ExtensionUIContext | undefined,
): ((request: SdkElicitationRequest, options: { signal: AbortSignal }) => Promise<SdkElicitationResult>) | undefined {
	if (!ui) return undefined;

	return async (request, { signal }) => {
		if (request.mode === "url") {
			return { action: "decline" };
		}

		const questions = parseAskUserQuestionsElicitation(request);
		if (questions) {
			const interviewResult = await showInterviewRound(questions, { signal }, { ui } as any).catch(() => undefined);
			if (interviewResult && Object.keys(interviewResult.answers).length > 0) {
				return {
					action: "accept",
					content: roundResultToElicitationContent(questions, interviewResult),
				};
			}

			return promptElicitationWithDialogs(request, questions, ui, signal);
		}

		const textFields = parseTextInputElicitation(request);
		if (textFields) {
			return promptTextInputElicitation(request, textFields, ui, signal);
		}

		return { action: "decline" };
	};
}

/**
 * Aborted by the caller's AbortSignal — distinct from exhaustion. GSD's
 * agent loop keys off `stopReason === "aborted"` to treat this as a clean
 * user cancel instead of a retry-eligible provider failure.
 */
export function makeAbortedMessage(model: string, lastTextContent: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: lastTextContent
			? [{ type: "text", text: lastTextContent }]
			: [{ type: "text", text: "Claude Code stream aborted by caller" }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "aborted",
		timestamp: Date.now(),
	};
	return message;
}

// ---------------------------------------------------------------------------
// SDK options builder
// ---------------------------------------------------------------------------

/**
 * Resolve the Claude Code permission mode for the current run.
 *
 * Defaults to `acceptEdits`, which auto-approves file reads/edits but
 * surfaces a permission dialog for dangerous operations (e.g. general Bash,
 * Agent, WebFetch). This prevents tools outside the allowlist from being
 * silently denied — the SDK emits an `extension_ui_request` event so the
 * user sees a prompt instead of a silent refusal that Claude Code mistakes
 * for user rejection (#4383).
 *
 * Set `GSD_CLAUDE_CODE_PERMISSION_MODE` to `bypassPermissions` to restore
 * the old always-approve behaviour, or to `default` / `plan` for stricter
 * modes.
 *
 * When `GSD_HEADLESS=1` is set (auto-mode / non-interactive runs), the
 * default flips to `bypassPermissions` because there is no UI to approve
 * permission dialogs — `acceptEdits` would hang verification commands like
 * `npx tsc --noEmit` or `npx vitest run` indefinitely (#4657). Explicit
 * overrides still win, so users can opt back into `acceptEdits` in headless.
 */
export async function resolveClaudePermissionMode(
	env: NodeJS.ProcessEnv = process.env,
): Promise<"bypassPermissions" | "acceptEdits" | "default" | "plan"> {
	const override = env.GSD_CLAUDE_CODE_PERMISSION_MODE?.trim();
	if (override === "bypassPermissions" || override === "acceptEdits" || override === "default" || override === "plan") {
		return override;
	}
	if (env.GSD_HEADLESS === "1") {
		console.warn(
			"[claude-code-cli] Headless mode detected (GSD_HEADLESS=1): defaulting permissionMode to 'bypassPermissions' so verification Bash commands can run. Set GSD_CLAUDE_CODE_PERMISSION_MODE=acceptEdits to opt out.",
		);
		return "bypassPermissions";
	}
	return "bypassPermissions";
}

// NOTE: These helpers intentionally mirror @gsd/pi-ai anthropic-shared
// behavior so this extension remains typecheck-stable even when the published
// @gsd/pi-ai barrel lags behind monorepo source exports.
/** Return true for model IDs that support the adaptive thinking API (Opus 4.6/4.7, Sonnet 4.6/4.7, Haiku 4.5). */
function modelSupportsAdaptiveThinking(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6")
		|| modelId.includes("opus-4.6")
		|| modelId.includes("opus-4-7")
		|| modelId.includes("opus-4.7")
		|| modelId.includes("sonnet-4-6")
		|| modelId.includes("sonnet-4.6")
		|| modelId.includes("sonnet-4-7")
		|| modelId.includes("sonnet-4.7")
		|| modelId.includes("haiku-4-5")
		|| modelId.includes("haiku-4.5")
	);
}

/** Map a GSD thinking level to the Anthropic effort value, clamping xhigh to max for models that lack native xhigh support. */
function mapThinkingLevelToAnthropicEffort(level: ThinkingLevel | undefined, modelId: string): "low" | "medium" | "high" | "xhigh" | "max" {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			if (modelId.includes("opus-4-7") || modelId.includes("opus-4.7")) return "xhigh";
			if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) return "max";
			return "high";
		default:
			return "high";
	}
}

/**
 * Build the options object passed to the Claude Agent SDK's `query()` call.
 *
 * Extracted for testability — callers can verify session persistence,
 * beta flags, and other configuration without mocking the full SDK.
 *
 * `permissionMode` / `allowDangerouslySkipPermissions` are resolved through
 * {@link resolveClaudePermissionMode} so interactive runs don't silently
 * bypass the SDK's permission gate. Callers that want the old always-bypass
 * behaviour pass `permissionMode: "bypassPermissions"` explicitly.
 */
export function buildSdkOptions(
	modelId: string,
	prompt: string,
	overrides?: { permissionMode?: "bypassPermissions" | "acceptEdits" | "default" | "plan" },
	extraOptions: Record<string, unknown> & { reasoning?: ThinkingLevel } = {},
): Record<string, unknown> {
	const { reasoning, ...sdkExtraOptions } = extraOptions;
	const mcpServers = buildWorkflowMcpServers();
	const permissionMode = overrides?.permissionMode ?? "bypassPermissions";
	// Globally unblock all tools. Users reported that the `acceptEdits` default
	// plus a narrow allowlist silently declined most Bash/Agent/WebFetch calls
	// when `extensionUIContext` wasn't threaded through. Default to
	// bypassPermissions and an empty disallow list so every tool — including
	// `AskUserQuestion` and every `mcp__*` workflow tool — is auto-approved.
	// Opt back into gated mode with GSD_CLAUDE_CODE_PERMISSION_MODE=acceptEdits.
	const disallowedTools: string[] = [];
	const allowedTools = [
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Bash",
		"Agent",
		"WebFetch",
		"WebSearch",
		"AskUserQuestion",
		...(mcpServers ? Object.keys(mcpServers).map((serverName) => `mcp__${serverName}__*`) : []),
	];
	const supportsAdaptive = modelSupportsAdaptiveThinking(modelId);
	const effort =
		reasoning && supportsAdaptive
			? mapThinkingLevelToAnthropicEffort(reasoning, modelId)
			: undefined;

	// Bug B: SDK requires thinking:{type:"adaptive"} alongside effort for adaptive thinking to activate.
	// Bug C: SDK requires thinking:{type:"disabled"} to actually stop adaptive thinking when reasoning is off;
	//        omitting the field leaves the SDK in its adaptive default (or persisted session state).
	const thinkingConfig = supportsAdaptive
		? effort
			? { thinking: { type: "adaptive" } }
			: { thinking: { type: "disabled" } }
		: undefined;

	return {
		pathToClaudeCodeExecutable: getClaudePath(),
		model: modelId,
		includePartialMessages: true,
		persistSession: true,
		cwd: process.cwd(),
		permissionMode,
		allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
		settingSources: ["project"],
		systemPrompt: { type: "preset", preset: "claude_code" },
		disallowedTools,
		...(allowedTools.length > 0 ? { allowedTools } : {}),
		...(mcpServers ? { mcpServers } : {}),
		betas: (modelId.includes("sonnet") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7")) ? ["context-1m-2025-08-07"] : [],
		...(thinkingConfig ?? {}),
		...(effort ? { effort } : {}),
		...sdkExtraOptions,
	};
}

/** Normalise heterogeneous SDK tool-result content (string, array, or object) into a uniform `ExternalToolResultContentBlock[]`. */
function normalizeToolResultContent(content: unknown): ExternalToolResultContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}

	if (!Array.isArray(content)) {
		if (content == null) return [{ type: "text", text: "" }];
		return [{ type: "text", text: JSON.stringify(content) }];
	}

	const blocks: ExternalToolResultContentBlock[] = [];

	for (const item of content) {
		if (typeof item === "string") {
			blocks.push({ type: "text", text: item });
			continue;
		}
		if (!item || typeof item !== "object") {
			blocks.push({ type: "text", text: String(item) });
			continue;
		}

		const block = item as Record<string, unknown>;
		if (block.type === "text") {
			blocks.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
			continue;
		}
		if (
			block.type === "image"
			&& typeof block.data === "string"
			&& typeof block.mimeType === "string"
		) {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}

		blocks.push({ type: "text", text: JSON.stringify(block) });
	}

	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/**
 * Extract a `details` payload from an MCP tool-result block.
 *
 * MCP's `CallToolResult` carries structured data in `structuredContent` — the
 * protocol's supported channel for non-text payloads. Claude Code's synthetic
 * user message may surface that field in one of two shapes depending on SDK
 * version: as a sibling on the `mcp_tool_result` block itself, or as a
 * dedicated content sub-block with `type: "structuredContent"`. Snake-case
 * (`structured_content`) is accepted defensively in case a transport hop
 * rewrites casing. All other shapes fall back to an empty object so callers
 * can rely on `details` being present.
 */
function extractStructuredDetailsFromBlock(block: Record<string, unknown>): Record<string, unknown> | undefined {
	const sibling = block.structuredContent ?? (block as Record<string, unknown>).structured_content;
	if (sibling && typeof sibling === "object" && !Array.isArray(sibling)) {
		return sibling as Record<string, unknown>;
	}

	if (Array.isArray(block.content)) {
		for (const item of block.content) {
			if (!item || typeof item !== "object") continue;
			const sub = item as Record<string, unknown>;
			if (sub.type !== "structuredContent" && sub.type !== "structured_content") continue;
			const payload = sub.structuredContent ?? sub.structured_content ?? sub.data ?? sub.value;
			if (payload && typeof payload === "object" && !Array.isArray(payload)) {
				return payload as Record<string, unknown>;
			}
		}
	}

	// Return undefined (not {}) when no structured payload is present, matching
	// the pre-#4477 contract where `details` was nullable. An empty-object
	// sentinel is truthy and breaks downstream consumers that gate on
	// `if (details)`. `undefined` matches the type of the field these results
	// flow into (`Record<string, unknown> | undefined`).
	return undefined;
}

/**
 * True for items that are MCP `structuredContent` pseudo-blocks living inside
 * a tool-result `content[]` array. These blocks carry the structured payload
 * (extracted separately by `extractStructuredDetailsFromBlock`) and must NOT
 * leak into the visible content rendered to the user — otherwise the renderer
 * stringifies the JSON pseudo-block and shows it next to the actual tool
 * output. See PR #4477 review (CodeRabbit, post-fix-round).
 */
function isStructuredContentPseudoBlock(item: unknown): boolean {
	if (!item || typeof item !== "object") return false;
	const type = (item as Record<string, unknown>).type;
	return type === "structuredContent" || type === "structured_content";
}

/**
 * Strip `structuredContent` pseudo-blocks from a tool-result content array
 * before normalization. The structured payload is extracted via the sibling
 * `structuredContent` field (or a dedicated extractor pass on the raw block);
 * the visible content path must not include the pseudo-block itself.
 */
function stripStructuredContentPseudoBlocks(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.filter((item) => !isStructuredContentPseudoBlock(item));
}

/** Extract tool result payloads from an SDK synthetic user message, keyed by tool-use ID. */
export function extractToolResultsFromSdkUserMessage(message: SDKUserMessage): Array<{
	toolUseId: string;
	result: ExternalToolResultPayload;
}> {
	const extracted: Array<{ toolUseId: string; result: ExternalToolResultPayload }> = [];
	const seen = new Set<string>();
	const rawMessage = message.message as Record<string, unknown> | null | undefined;
	const content = Array.isArray(rawMessage?.content) ? rawMessage.content : [];

	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		const type = typeof block.type === "string" ? block.type : "";
		if (type !== "tool_result" && type !== "mcp_tool_result") continue;

		const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
		if (!toolUseId || seen.has(toolUseId)) continue;
		seen.add(toolUseId);

		extracted.push({
			toolUseId,
			result: {
				content: normalizeToolResultContent(stripStructuredContentPseudoBlocks(block.content)),
				details: extractStructuredDetailsFromBlock(block),
				isError: block.is_error === true,
			},
		});
	}

	if (extracted.length === 0) {
		const fallback = message.tool_use_result;
		if (fallback && typeof fallback === "object") {
			const toolResult = fallback as Record<string, unknown>;
			const toolUseId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "";
			if (toolUseId) {
				extracted.push({
					toolUseId,
					result: {
						content: normalizeToolResultContent(stripStructuredContentPseudoBlocks(toolResult.content)),
						details: extractStructuredDetailsFromBlock(toolResult),
						isError: toolResult.is_error === true,
					},
				});
			}
		}
	}

	return extracted;
}

/** Attach external tool results from the SDK synthetic user message to their corresponding tool-call blocks by ID. */
function attachExternalResultsToToolBlocks(
	toolBlocks: AssistantMessage["content"],
	toolResultsById: ReadonlyMap<string, ExternalToolResultPayload>,
): void {
	for (const block of toolBlocks) {
		if (block.type !== "toolCall" && block.type !== "serverToolUse") continue;
		const externalResult = toolResultsById.get(block.id);
		if (!externalResult) continue;
		(block as ToolCallWithExternalResult & { id: string }).externalResult = externalResult;
	}
}

/**
 * Build the final assistant content that Agent Core consumes in
 * `externalToolExecution` mode. This preserves tool-call blocks, attaches any
 * SDK-produced external results by tool-call id, and then appends the final
 * text/thinking blocks for the completed turn.
 */
export function buildFinalAssistantContent(params: {
	intermediateToolBlocks: AssistantMessage["content"];
	pendingContent?: AssistantMessage["content"];
	toolResultsById: ReadonlyMap<string, ExternalToolResultPayload>;
	lastThinkingContent?: string;
	lastTextContent?: string;
	fallbackResultText?: string;
}): AssistantMessage["content"] {
	const mergedToolBlocks = [...params.intermediateToolBlocks];
	if (params.pendingContent) {
		mergePendingToolCalls(mergedToolBlocks, params.pendingContent);
	}
	attachExternalResultsToToolBlocks(mergedToolBlocks, params.toolResultsById);

	const finalContent: AssistantMessage["content"] = [...mergedToolBlocks];
	if (params.pendingContent && params.pendingContent.length > 0) {
		for (const block of params.pendingContent) {
			if (block.type === "text" || block.type === "thinking") {
				finalContent.push(block);
			}
		}
	} else {
		if (params.lastThinkingContent) {
			finalContent.push({ type: "thinking", thinking: params.lastThinkingContent });
		}
		if (params.lastTextContent) {
			finalContent.push({ type: "text", text: params.lastTextContent });
		}
	}

	if (finalContent.length === 0 && params.fallbackResultText) {
		finalContent.push({ type: "text", text: params.fallbackResultText });
	}

	return finalContent;
}

/**
 * Merge tool-call blocks from the active partial-message builder into the
 * running list of intermediate tool calls, preserving order and de-duping
 * by tool-call id. Exposed for testing the F3 fix (final-turn tool calls
 * dropped when `result` arrives without a preceding synthetic `user`).
 */
export function mergePendingToolCalls(
	intermediate: AssistantMessage["content"],
	pending: AssistantMessage["content"],
): AssistantMessage["content"] {
	const alreadyIncluded = new Set<string>();
	for (const block of intermediate) {
		if (block.type === "toolCall") alreadyIncluded.add(block.id);
	}
	for (const block of pending) {
		if (block.type !== "toolCall") continue;
		if (alreadyIncluded.has(block.id)) continue;
		alreadyIncluded.add(block.id);
		intermediate.push(block);
	}
	return intermediate;
}

// ---------------------------------------------------------------------------
// streamSimple implementation
// ---------------------------------------------------------------------------

/**
 * GSD streamSimple function that delegates to the Claude Agent SDK.
 *
 * Emits AssistantMessageEvent deltas for real-time TUI rendering
 * (thinking, text, tool calls). The final AssistantMessage preserves
 * SDK-executed tool-call blocks for Agent Core's `externalToolExecution`
 * path, which renders the results without dispatching the tools locally.
 */
export function streamViaClaudeCode(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantStream();

	void pumpSdkMessages(model, context, options, stream);

	return stream;
}

/** Async pump that drives the Claude Agent SDK's async-iterable message stream and pushes events into `stream`. */
async function pumpSdkMessages(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const modelId = model.id;
	let builder: PartialMessageBuilder | null = null;
	/** Track the last text content seen across all assistant turns for the final message. */
	let lastTextContent = "";
	let lastThinkingContent = "";
	/** Collect tool blocks from intermediate SDK turns for tool execution rendering. */
	const intermediateToolBlocks: AssistantMessage["content"] = [];
	/** Preserve real external tool results from Claude Code's synthetic user messages. */
	const toolResultsById = new Map<string, ExternalToolResultPayload>();

	try {
		// Dynamic import — the SDK is an optional dependency.
		const sdkModule = "@anthropic-ai/claude-agent-sdk";
		const sdk = (await import(/* webpackIgnore: true */ sdkModule)) as {
			query: (args: {
				prompt: string | AsyncIterable<unknown>;
				options?: Record<string, unknown>;
			}) => AsyncIterable<SDKMessage>;
		};

		// Bridge GSD's AbortSignal to SDK's AbortController
		const controller = new AbortController();
		if (options?.signal) {
			options.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const prompt = buildPromptFromContext(context);
		const queryPrompt = buildSdkQueryPrompt(context, prompt);
		const permissionMode = await resolveClaudePermissionMode();
		const uiContext = (options as ClaudeCodeStreamOptions | undefined)?.extensionUIContext;
		const canUseToolHandler = createClaudeCodeCanUseToolHandler(uiContext);
		// When no UI is available (headless / auto-mode), auto-approve all
		// tool requests. This replaces the old bypassPermissions workaround.
		const canUseToolFallback = canUseToolHandler
			?? (async (_toolName: string, _input: Record<string, unknown>, opts: CanUseToolOptions): Promise<CanUseToolPermissionResult> =>
				({ behavior: "allow", toolUseID: opts.toolUseID }));
		const sdkOpts = buildSdkOptions(
			modelId,
			prompt,
			{ permissionMode },
			{
				reasoning: options?.reasoning,
				canUseTool: canUseToolFallback,
				...(uiContext
					? {
							onElicitation: createClaudeCodeElicitationHandler(uiContext),
						}
					: {}),
			},
		);

		const queryResult = sdk.query({
			prompt: queryPrompt,
			options: {
				...sdkOpts,
				abortController: controller,
			},
		});

		// Emit start with an empty partial
		const initialPartial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "claude-code",
			model: modelId,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: initialPartial });

		for await (const msg of queryResult as AsyncIterable<SDKMessage>) {
			if (options?.signal?.aborted) {
				// User-initiated cancel — emit an aborted error so the agent
				// loop classifies this as a deliberate stop, not a transient
				// provider failure that should be retried.
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(modelId, lastTextContent),
				});
				return;
			}

			switch (msg.type) {
				// -- Init --
				case "system": {
					// Nothing to emit — the stream is already started.
					break;
				}

				// -- Streaming partial messages --
				case "stream_event": {
					const partial = msg as SDKPartialAssistantMessage;

					const event = partial.event;

					// New assistant turn starts with message_start
					if (event.type === "message_start") {
						builder = new PartialMessageBuilder(
							(event as any).message?.model ?? modelId,
						);
						break;
					}

					if (!builder) break;

					const assistantEvent = builder.handleEvent(event);
					if (assistantEvent) {
						stream.push(assistantEvent);
					}
					break;
				}

				// -- Complete assistant message (non-streaming fallback) --
				case "assistant": {
					const sdkAssistant = msg as SDKAssistantMessage;

					// Capture text content from complete messages
					for (const block of sdkAssistant.message.content) {
						if (block.type === "text") {
							lastTextContent = block.text;
						} else if (block.type === "thinking") {
							lastThinkingContent = block.thinking;
						}
					}
					break;
				}

				// -- User message (synthetic tool result — signals turn boundary) --
				case "user": {
					// Capture content from the completed turn before resetting
					if (builder) {
						for (const block of builder.message.content) {
							if (block.type === "text" && block.text) {
								lastTextContent = block.text;
							} else if (block.type === "thinking" && block.thinking) {
								lastThinkingContent = block.thinking;
							} else if (block.type === "toolCall" || block.type === "serverToolUse") {
								// Collect tool blocks for externalToolExecution rendering
								intermediateToolBlocks.push(block);
							}
						}
					}

					// Extract tool results from the SDK's synthetic user message
					// and attach to corresponding tool call blocks immediately.
					for (const { toolUseId, result } of extractToolResultsFromSdkUserMessage(msg as SDKUserMessage)) {
						toolResultsById.set(toolUseId, result);
					}
					attachExternalResultsToToolBlocks(intermediateToolBlocks, toolResultsById);

					// Push a synthetic toolcall_end for each tool call from this turn
					// so the TUI can render tool results in real-time during the SDK
					// session instead of waiting until the entire session completes.
					if (builder) {
						for (const block of builder.message.content) {
							const extResult = (block as ToolCallWithExternalResult).externalResult;
							if (!extResult) continue;
							const contentIndex = builder.message.content.indexOf(block);
							if (contentIndex < 0) continue;
							// Push synthetic completion events with result attached so the
							// chat-controller can update pending ToolExecutionComponents.
							if (block.type === "toolCall") {
								stream.push({
									type: "toolcall_end",
									contentIndex,
									toolCall: block,
									partial: builder.message,
								});
							} else if (block.type === "serverToolUse") {
								stream.push({
									type: "server_tool_use",
									contentIndex,
									partial: builder.message,
								});
							}
						}
					}

					builder = null;
					break;
				}

				// -- Result (terminal) --
				case "result": {
					const result = msg as SDKResultMessage;
					const finalContent = buildFinalAssistantContent({
						intermediateToolBlocks,
						pendingContent: builder?.message.content,
						toolResultsById,
						lastThinkingContent,
						lastTextContent,
						fallbackResultText:
							result.subtype === "success" && result.result ? result.result : undefined,
					});

					const finalMessage: AssistantMessage = {
						role: "assistant",
						content: finalContent,
						api: "anthropic-messages",
						provider: "claude-code",
						model: modelId,
						usage: mapUsage(result.usage, result.total_cost_usd),
						stopReason: result.is_error ? "error" : "stop",
						timestamp: Date.now(),
					};

					if (result.is_error) {
						finalMessage.errorMessage = getResultErrorMessage(result);
						stream.push({ type: "error", reason: "error", error: finalMessage });
					} else {
						stream.push({ type: "done", reason: "stop", message: finalMessage });
					}
					return;
				}

				default:
					break;
			}
		}

		// Generator exhaustion without a terminal result is a stream interruption,
		// not a successful completion. Emitting an error lets GSD classify it as a
		// transient provider failure instead of advancing auto-mode state.
		const fallback = makeStreamExhaustedErrorMessage(modelId, lastTextContent);
		stream.push({ type: "error", reason: "error", error: fallback });
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		stream.push({
			type: "error",
			reason: "error",
			error: makeErrorMessage(modelId, errorMsg),
		});
	}
}
