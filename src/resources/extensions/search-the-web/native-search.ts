/**
 * Native Anthropic web search hook logic.
 *
 * Extracted from index.ts so it can be unit-tested without importing
 * the heavy tool-registration modules.
 */

/** Tool names for the Brave-backed custom search tools */
export const BRAVE_TOOL_NAMES = ["search-the-web", "search_and_read"];

/** All custom search tool names that should be disabled when native search is active */
export const CUSTOM_SEARCH_TOOL_NAMES = ["search-the-web", "search_and_read", "google_search"];

/** Thinking block types that require signature validation by the API */
const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

/** Minimal interface matching the subset of ExtensionAPI we use */
export interface NativeSearchPI {
  on(event: string, handler: (...args: any[]) => any): void;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
}

/**
 * Strip thinking/redacted_thinking blocks from assistant messages in the
 * conversation history.
 *
 * Why: The Pi SDK's streaming parser drops `server_tool_use` and
 * `web_search_tool_result` content blocks (unknown types). When the
 * conversation is replayed, the assistant messages are incomplete — missing
 * those blocks. The Anthropic API detects the modification and rejects the
 * request with "thinking blocks cannot be modified."
 *
 * Fix: Remove thinking blocks from all assistant messages in the history.
 * In Anthropic's Messages API, the messages array always ends with a user
 * message, so every assistant message is from a previous turn that has been
 * through a store/replay cycle. The model generates fresh thinking for the
 * current turn regardless.
 */
export function stripThinkingFromHistory(
  messages: Array<Record<string, unknown>>
): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    msg.content = content.filter(
      (block: any) => !THINKING_TYPES.has(block?.type)
    );
  }
}

/**
 * Register model_select, before_provider_request, and session_start hooks
 * for native Anthropic web search injection.
 *
 * Returns the isAnthropicProvider getter for testing.
 */
export function registerNativeSearchHooks(pi: NativeSearchPI): { getIsAnthropic: () => boolean } {
  let isAnthropicProvider = false;
  let modelSelectFired = false;

  // Track provider changes via model selection — also handles diagnostics
  // since model_select fires AFTER session_start and knows the provider.
  pi.on("model_select", async (event: any, ctx: any) => {
    modelSelectFired = true;
    const wasAnthropic = isAnthropicProvider;
    isAnthropicProvider = event.model.provider === "anthropic";

    const hasBrave = !!process.env.BRAVE_API_KEY;

    // When Anthropic: disable all custom search tools — native web_search is
    // server-side and more reliable. Custom tools cause confusion and failures.
    if (isAnthropicProvider) {
      const active = pi.getActiveTools();
      pi.setActiveTools(
        active.filter((t: string) => !CUSTOM_SEARCH_TOOL_NAMES.includes(t))
      );
    } else if (!isAnthropicProvider && wasAnthropic) {
      // Switching away from Anthropic — re-enable custom search tools (they
      // were disabled while native search was active). If keys are missing,
      // user sees the error rather than tools silently vanishing.
      const active = pi.getActiveTools();
      const toAdd = CUSTOM_SEARCH_TOOL_NAMES.filter((t) => !active.includes(t));
      if (toAdd.length > 0) {
        pi.setActiveTools([...active, ...toAdd]);
      }
    }

    // Show provider-aware diagnostics on first selection or provider change
    if (isAnthropicProvider && !wasAnthropic && event.source !== "restore") {
      ctx.ui.notify("Native Anthropic web search active", "info");
    } else if (!isAnthropicProvider && !hasBrave) {
      ctx.ui.notify(
        "Web search: Set BRAVE_API_KEY or use an Anthropic model for built-in search",
        "warning"
      );
    }
  });

  // Inject native web search into Anthropic API requests
  pi.on("before_provider_request", (event: any) => {
    const payload = event.payload as Record<string, unknown>;
    if (!payload) return;

    // Detect Anthropic provider. Prefer the model_select flag when available,
    // but fall back to checking the model name in the payload. model_select
    // may not fire when the session restores with the same model already set
    // (modelsAreEqual guard in the SDK suppresses the event). When model_select
    // HAS fired and said "not Anthropic" (e.g. Copilot serving claude-*),
    // respect that — don't override with model name heuristic.
    const modelName = typeof payload.model === "string" ? payload.model : "";
    const isAnthropic = modelSelectFired
      ? isAnthropicProvider
      : modelName.startsWith("claude-");
    if (!isAnthropic) return;

    // Strip thinking blocks from history to avoid signature validation errors
    // caused by the SDK dropping server_tool_use/web_search_tool_result blocks.
    const messages = payload.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(messages)) {
      stripThinkingFromHistory(messages);
    }

    if (!Array.isArray(payload.tools)) payload.tools = [];

    let tools = payload.tools as Array<Record<string, unknown>>;

    // Don't double-inject if already present
    if (tools.some((t) => t.type === "web_search_20250305")) return;

    // Always remove custom search tool definitions from Anthropic requests.
    // Native web_search is server-side and more reliable — keeping both confuses
    // the model and causes it to pick custom tools which can fail with network errors.
    tools = tools.filter(
      (t) => !CUSTOM_SEARCH_TOOL_NAMES.includes(t.name as string)
    );
    payload.tools = tools;

    tools.push({
      type: "web_search_20250305",
      name: "web_search",
    });

    return payload;
  });

  // Basic startup diagnostics — provider-specific info comes from model_select
  pi.on("session_start", async (_event: any, ctx: any) => {
    const hasBrave = !!process.env.BRAVE_API_KEY;
    const hasJina = !!process.env.JINA_API_KEY;
    const hasAnswers = !!process.env.BRAVE_ANSWERS_KEY;

    const parts: string[] = ["Web search v4 loaded"];
    if (hasBrave) parts.push("Brave ✓");
    if (hasAnswers) parts.push("Answers ✓");
    if (hasJina) parts.push("Jina ✓");

    ctx.ui.notify(parts.join(" · "), "info");
  });

  return { getIsAnthropic: () => isAnthropicProvider };
}
