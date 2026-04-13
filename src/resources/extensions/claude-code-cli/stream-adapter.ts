/**
 * Stream adapter: bridges the Claude Agent SDK into GSD's streamSimple contract.
 *
 * The SDK runs the full agentic loop (multi-turn, tool execution, compaction)
 * in one call. This adapter translates the SDK's streaming output into
 * AssistantMessageEvents for TUI rendering, then strips tool-call blocks from
 * the final AssistantMessage so GSD's agent loop doesn't try to dispatch them.
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
import { EventStream, mapThinkingLevelToEffort, supportsAdaptiveThinking } from "@gsd/pi-ai";
import { execSync } from "node:child_process";
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

export interface ExternalToolResultContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ExternalToolResultPayload {
	content: ExternalToolResultContentBlock[];
	details?: Record<string, unknown>;
	isError: boolean;
}

type ToolCallWithExternalResult = ToolCall & {
	externalResult?: ExternalToolResultPayload;
};

interface ClaudeCodeStreamOptions extends SimpleStreamOptions {
	extensionUIContext?: ExtensionUIContext;
}

interface SdkElicitationRequestOption {
	const?: string;
	title?: string;
}

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

interface SdkElicitationResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, string | string[]>;
}

interface ParsedElicitationQuestion extends Question {
	noteFieldId?: string;
}

interface ParsedTextInputField {
	id: string;
	title: string;
	description: string;
	required: boolean;
	secure: boolean;
}

const OTHER_OPTION_LABEL = "None of the above";
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

let cachedClaudePath: string | null = null;

export function getClaudeLookupCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "where claude" : "which claude";
}

export function parseClaudeLookupOutput(output: Buffer | string): string {
	return output
		.toString()
		.trim()
		.split(/\r?\n/)[0] ?? "";
}

/**
 * Resolve the path to the system-installed `claude` binary.
 * The SDK defaults to a bundled cli.js which doesn't exist when
 * installed as a library — we need to point it at the real CLI.
 */
function getClaudePath(): string {
	if (cachedClaudePath) return cachedClaudePath;
	try {
		cachedClaudePath = parseClaudeLookupOutput(execSync(getClaudeLookupCommand(), { timeout: 5_000, stdio: "pipe" }));
	} catch {
		cachedClaudePath = "claude"; // fall back to PATH resolution
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

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

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

function readElicitationChoices(options: SdkElicitationRequestOption[] | undefined): string[] {
	if (!Array.isArray(options)) return [];
	return options
		.map((option) => (typeof option?.const === "string" ? option.const : typeof option?.title === "string" ? option.title : ""))
		.filter((option): option is string => option.length > 0);
}

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

function buildElicitationPromptTitle(request: SdkElicitationRequest, question: ParsedElicitationQuestion): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		question.header,
		question.question,
	].filter((part) => part && part.trim().length > 0);
	return parts.join("\n\n");
}

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

function buildTextInputPromptTitle(request: SdkElicitationRequest, field: ParsedTextInputField): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		field.title,
		field.description,
	].filter((part) => typeof part === "string" && part.trim().length > 0);
	return parts.join("\n\n");
}

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
 * GSD subagents run underneath a host Claude Code session the user has
 * already consented to, and their work (edits, shell inspection, MCP calls)
 * spans the full workflow toolset. Defaulting the inner SDK to
 * `bypassPermissions` avoids per-tool approval prompts that offer no
 * meaningful safety beyond what the host session and the subagent prompts
 * already enforce. `GSD_CLAUDE_CODE_PERMISSION_MODE` lets security-conscious
 * users opt into a stricter mode (`acceptEdits`, `default`, `plan`).
 *
 * Tradeoff: bypass means a prompt-injection payload read from an untrusted
 * file could trigger tool calls without a second gate. Accepted for GSD
 * because the workflow is explicit user intent and the alternative
 * (#4099) is continuous approval fatigue that blocks real work.
 */
export async function resolveClaudePermissionMode(
	env: NodeJS.ProcessEnv = process.env,
): Promise<"bypassPermissions" | "acceptEdits" | "default" | "plan"> {
	const override = env.GSD_CLAUDE_CODE_PERMISSION_MODE?.trim();
	if (override === "bypassPermissions" || override === "acceptEdits" || override === "default" || override === "plan") {
		return override;
	}
	return "bypassPermissions";
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
	const disallowedTools = ["AskUserQuestion"];
	// Pre-authorize the safe built-ins and every registered workflow MCP
	// server's tools. `acceptEdits` mode (the interactive default) only
	// auto-approves file edits — Read/Glob/Grep, basic shell inspection, and
	// every `mcp__gsd-workflow__*` call still surface as "This command
	// requires approval" and block GSD actions (#4099).
	const allowedTools = [
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Bash(ls:*)",
		"Bash(pwd)",
		...(mcpServers ? Object.keys(mcpServers).map((serverName) => `mcp__${serverName}__*`) : []),
	];
	const effort =
		reasoning && supportsAdaptiveThinking(modelId)
			? mapThinkingLevelToEffort(reasoning, modelId)
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
		betas: modelId.includes("sonnet") ? ["context-1m-2025-08-07"] : [],
		...(effort ? { effort } : {}),
		...sdkExtraOptions,
	};
}

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
				content: normalizeToolResultContent(block.content),
				details: {},
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
						content: normalizeToolResultContent(toolResult.content),
						details: {},
						isError: toolResult.is_error === true,
					},
				});
			}
		}
	}

	return extracted;
}

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
 * (thinking, text, tool calls). The final AssistantMessage has tool-call
 * blocks stripped so the agent loop ends the turn without local dispatch.
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
		const permissionMode = await resolveClaudePermissionMode();
		const sdkOpts = buildSdkOptions(
			modelId,
			prompt,
			{ permissionMode },
			typeof (options as ClaudeCodeStreamOptions | undefined)?.extensionUIContext === "object"
				? {
						reasoning: options?.reasoning,
						onElicitation: createClaudeCodeElicitationHandler(
							(options as ClaudeCodeStreamOptions | undefined)?.extensionUIContext,
						),
					}
				: { reasoning: options?.reasoning },
		);

		const queryResult = sdk.query({
			prompt,
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

					// Build final message. Include intermediate tool calls so the
					// agent loop's externalToolExecution path emits tool_execution
					// events for proper TUI rendering, followed by the text response.
					const finalContent: AssistantMessage["content"] = [];

					// If the final turn ended without a synthetic user message
					// (e.g. stop_reason: "tool_use" followed directly by result,
					// or a turn with text but no tool execution), the `builder`
					// still holds toolCall blocks that were never pushed into
					// `intermediateToolBlocks`. Fold them in here so they aren't
					// dropped from the final AssistantMessage.
					if (builder) {
						mergePendingToolCalls(intermediateToolBlocks, builder.message.content);
					}

					// Add tool calls from intermediate turns first (renders above text)
					attachExternalResultsToToolBlocks(intermediateToolBlocks, toolResultsById);
					finalContent.push(...intermediateToolBlocks);

					// Add text/thinking from the last turn
					if (builder && builder.message.content.length > 0) {
						for (const block of builder.message.content) {
							if (block.type === "text" || block.type === "thinking") {
								finalContent.push(block);
							}
						}
					} else {
						if (lastThinkingContent) {
							finalContent.push({ type: "thinking", thinking: lastThinkingContent });
						}
						if (lastTextContent) {
							finalContent.push({ type: "text", text: lastTextContent });
						}
					}

					// Fallback: use the SDK's result text if we have no content
					if (finalContent.length === 0 && result.subtype === "success" && result.result) {
						finalContent.push({ type: "text", text: result.result });
					}

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
