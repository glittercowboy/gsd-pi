/**
 * Native Anthropic web search hook logic.
 *
 * Extracted from index.ts so it can be unit-tested without importing
 * the heavy tool-registration modules.
 */

import { isAnthropicApi } from "@gsd/pi-ai";
import { resolveSearchProviderFromPreferences } from "../gsd/preferences.js";

/** Tool names for the Brave-backed custom search tools */
export const BRAVE_TOOL_NAMES = ["search-the-web", "search_and_read"];

/** All custom search tool names that should be disabled when native search is active */
export const CUSTOM_SEARCH_TOOL_NAMES = ["search-the-web", "search_and_read", "google_search"];

/** Thinking block types that require signature validation by the API */
const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

/**
 * Providers whose Anthropic-Messages endpoint is known to accept the native
 * `web_search_20250305` server tool. Anthropic-shaped transports NOT in this
 * set (github-copilot, minimax, kimi-coding, opencode, vercel-ai-gateway,
 * etc.) route Claude or Claude-compatible models through the Messages API
 * but do NOT expose the server-side search tool — injecting it yields a
 * 400 "unsupported_value" from their endpoints (regression from #4492).
 *
 * Keep this allowlist tight — err on the side of custom/Brave search rather
 * than a runtime 400. Add a provider here only after confirming its endpoint
 * accepts the tool type.
 */
const NATIVE_WEB_SEARCH_PROVIDERS = new Set([
  "anthropic",
  "claude-code",
  "anthropic-vertex",
  "vercel-ai-gateway",
]);

/**
 * True when the model is an Anthropic-shaped transport AND the provider is
 * known to accept the native `web_search_20250305` tool. Gate both on api
 * shape (#4478 / ADR-012) and on provider identity (#444 regression guard
 * and #4492 scope correction) — provider-level discrimination is legitimate
 * per ADR-012 for credential/behavior differences that api shape can't
 * express.
 */
export function supportsNativeWebSearch(
  model: { api?: string; provider?: string } | null | undefined
): boolean {
  if (!isAnthropicApi(model)) return false;
  const provider = model?.provider;
  return typeof provider === "string" && NATIVE_WEB_SEARCH_PROVIDERS.has(provider);
}

/**
 * Maximum number of native web searches allowed per session (agent unit).
 * The Anthropic API's `max_uses` is per-request — it resets on each API call.
 * When `pause_turn` triggers a resubmit, the model gets a fresh budget.
 * This session-level cap prevents unbounded search accumulation (#1309).
 *
 * 15 = 3 full turns of 5 searches each — generous for research, but bounded.
 */
export const MAX_NATIVE_SEARCHES_PER_SESSION = 15;

/** When true, skip native web search injection and keep Brave/custom tools active on Anthropic. */
export function preferBraveSearch(): boolean {
  // PREFERENCES.md takes priority over env var
  const prefsPref = resolveSearchProviderFromPreferences();
  if (prefsPref === "brave" || prefsPref === "tavily" || prefsPref === "ollama") return true;
  if (prefsPref === "native") return false;
  // Fall back to env var
  return process.env.PREFER_BRAVE_SEARCH === "1" || process.env.PREFER_BRAVE_SEARCH === "true";
}

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

  // Session-level native search counter (#1309).
  // Tracks cumulative web_search_tool_result blocks across all turns in a session.
  // Reset on session_start. Used to compute remaining budget for max_uses.
  let sessionSearchCount = 0;

  // Track provider changes via model selection — also handles diagnostics
  // since model_select fires AFTER session_start and knows the provider.
  pi.on("model_select", async (event: any, ctx: any) => {
    modelSelectFired = true;
    const wasAnthropic = isAnthropicProvider;
    // Gate on api shape AND provider allowlist: direct Anthropic, claude-code
    // OAuth, and anthropic-vertex accept `web_search_20250305`; copilot /
    // minimax / kimi / opencode route Claude-compat models through the same
    // wire protocol but reject the server-side tool (#4492 regression).
    isAnthropicProvider = supportsNativeWebSearch(event.model);

    const hasBrave = !!process.env.BRAVE_API_KEY;

    // When Anthropic (and not preferring Brave): disable custom search tools —
    // native web_search is server-side and more reliable.
    if (isAnthropicProvider && !preferBraveSearch()) {
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
    if (isAnthropicProvider && !preferBraveSearch() && !wasAnthropic && event.source !== "restore") {
      ctx.ui.notify("Native Anthropic web search active", "info");
    } else if (isAnthropicProvider && preferBraveSearch() && !wasAnthropic && event.source !== "restore") {
      ctx.ui.notify("Brave search active (PREFER_BRAVE_SEARCH)", "info");
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

    // Detect Anthropic provider. Use the model object from the event (most
    // reliable — comes directly from the resolved Model), then fall back to
    // the model_select flag, then to the model name heuristic (last resort).
    // The model name heuristic is needed for session restores where
    // modelsAreEqual suppresses model_select AND the SDK doesn't pass model.
    const eventModel = event.model as { provider?: string; api?: string } | undefined;
    let isAnthropic: boolean;
    if (eventModel?.api || eventModel?.provider) {
      // Preferred path: gate on api shape + provider allowlist. Both fields
      // are authoritative when present — do NOT fall back to the model-name
      // heuristic, which would misclassify copilot-served Claude as Anthropic
      // (#444 regression) or minimax-served Claude-compat as Anthropic (#4492).
      isAnthropic = supportsNativeWebSearch(eventModel);
    } else if (modelSelectFired) {
      isAnthropic = isAnthropicProvider;
    } else {
      // Last resort: session-restore paths where the SDK doesn't pass model.
      // The model-name prefix is best-effort and assumes direct Anthropic.
      const modelName = typeof payload.model === "string" ? payload.model : "";
      isAnthropic = modelName.startsWith("claude-");
    }
    if (!isAnthropic) return;

    // Strip thinking blocks from history to avoid signature validation errors
    // caused by the SDK dropping server_tool_use/web_search_tool_result blocks.
    const messages = payload.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(messages)) {
      stripThinkingFromHistory(messages);
    }

    // When preferring Brave, skip native search injection entirely
    if (preferBraveSearch()) return;

    if (!Array.isArray(payload.tools)) payload.tools = [];

    let tools = payload.tools as Array<Record<string, unknown>>;

    // Don't double-inject if already present
    if (tools.some((t) => t.type === "web_search_20250305")) return;

    // Remove custom search tool definitions from Anthropic requests.
    // Native web_search is server-side and more reliable — keeping both confuses
    // the model and causes it to pick custom tools which can fail with network errors.
    tools = tools.filter(
      (t) => !CUSTOM_SEARCH_TOOL_NAMES.includes(t.name as string)
    );
    payload.tools = tools;

    // ── Session-level search budget (#1309, #compaction-safe) ─────────────
    // Count web_search_tool_result blocks in the conversation history to
    // determine how many native searches have already been used this session.
    // The Anthropic API's max_uses resets per request, so without this guard,
    // pause_turn → resubmit cycles allow unlimited total searches.
    //
    // Use the monotonic high-water mark: take the max of the history count
    // and the running counter. This prevents budget resets when context
    // compaction removes web_search_tool_result blocks from history.
    if (Array.isArray(messages)) {
      let historySearchCount = 0;
      for (const msg of messages) {
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if ((block as any)?.type === "web_search_tool_result") {
            historySearchCount++;
          }
        }
      }
      // High-water mark: never decrease the counter, even if compaction
      // removes web_search_tool_result blocks from the visible history.
      sessionSearchCount = Math.max(sessionSearchCount, historySearchCount);
    }

    const remaining = Math.max(0, MAX_NATIVE_SEARCHES_PER_SESSION - sessionSearchCount);

    if (remaining <= 0) {
      // Budget exhausted — don't inject the search tool at all.
      // The model will proceed without web search capability.
      return payload;
    }

    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      // Cap per-request searches to the lesser of 5 (per-turn cap) or the
      // remaining session budget (#1309). This prevents the model from
      // consuming unlimited searches via pause_turn → resubmit cycles.
      max_uses: Math.min(5, remaining),
    });

    return payload;
  });

  pi.on("session_start", async (_event: any, _ctx: any) => {
    // Reset session-level search budget (#1309)
    sessionSearchCount = 0;
  });

  return { getIsAnthropic: () => isAnthropicProvider };
}
