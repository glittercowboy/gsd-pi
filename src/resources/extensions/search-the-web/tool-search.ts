/**
 * search-the-web tool — Rich web search with full Brave API support.
 *
 * v3 improvements:
 * - Structured error taxonomy (auth_error, rate_limited, network_error, etc.)
 * - Spellcheck/query correction surfacing
 * - Latency tracking in details
 * - more_results_available from Brave response
 * - Adaptive snippet budget (fewer results = more snippets each)
 * - Rate limit info in details
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";

import { LRUTTLCache } from "./cache.js";
import { fetchWithRetryTimed, fetchWithRetry, classifyError, type RateLimitInfo } from "./http.js";
import { normalizeQuery, toDedupeKey, detectFreshness } from "./url-utils.js";
import { formatSearchResults, type SearchResultFormatted, type FormatSearchOptions } from "./format.js";
import { getTavilyApiKey, getOllamaApiKey, getBraveApiKey, braveHeaders, resolveSearchProvider } from "./provider.js";
import { normalizeTavilyResult, mapFreshnessToTavily, type TavilySearchResponse } from "./tavily.js";

// =============================================================================
// Types
// =============================================================================

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
  language?: string;
  extra_snippets?: string[];
  meta_url?: { scheme?: string; netloc?: string; hostname?: string; path?: string };
  [key: string]: unknown;
}

interface BraveSummarizerResponse {
  type?: string;
  status?: number;
  title?: string;
  summary?: Array<{ type: string; data: string }>;
  enrichments?: unknown;
  [key: string]: unknown;
}

interface BraveSearchResponse {
  query?: {
    original?: string;
    altered?: string;
    show_strict_warning?: boolean;
    more_results_available?: boolean;
    spellcheck_off?: boolean;
  };
  web?: {
    results?: BraveWebResult[];
  };
  summarizer?: {
    key?: string;
  };
  [key: string]: unknown;
}

interface CachedSearchResult {
  results: SearchResultFormatted[];
  summarizerKey?: string;
  summaryText?: string;
  queryCorrected?: boolean;
  originalQuery?: string;
  correctedQuery?: string;
  moreResultsAvailable?: boolean;
}

/** Structured details returned from the search tool. */
interface SearchDetails {
  query: string;
  effectiveQuery: string;
  results: SearchResultFormatted[];
  count: number;
  cached: boolean;
  freshness: string;
  hasSummary: boolean;
  latencyMs?: number;
  rateLimit?: RateLimitInfo;
  queryCorrected?: boolean;
  originalQuery?: string;
  correctedQuery?: string;
  moreResultsAvailable?: boolean;
  errorKind?: string;
  error?: string;
  retryAfterMs?: number;
  provider?: 'tavily' | 'brave' | 'ollama';
}

// =============================================================================
// Caches
// =============================================================================

// Search results: max 100 entries, 10-minute TTL
const searchCache = new LRUTTLCache<CachedSearchResult>({ max: 100, ttlMs: 600_000 });
searchCache.startPurgeInterval(60_000);

// Consecutive duplicate search guard (#949)
// Tracks recent query keys to detect and break search loops.
const MAX_CONSECUTIVE_DUPES = 3;
let lastSearchKey = "";
let consecutiveDupeCount = 0;

/** Reset session-scoped duplicate-search guard state. */
export function resetSearchLoopGuardState(): void {
  lastSearchKey = "";
  consecutiveDupeCount = 0;
}

// Summarizer responses: max 50 entries, 15-minute TTL
const summarizerCache = new LRUTTLCache<string>({ max: 50, ttlMs: 900_000 });

// =============================================================================
// Brave API helpers
// =============================================================================

/**
 * Normalize a Brave result into our formatted result type.
 */
function normalizeBraveResult(r: BraveWebResult): SearchResultFormatted {
  return {
    title: r.title || "(untitled)",
    url: r.url,
    description: r.description || "",
    age: r.age || r.page_age || undefined,
    extra_snippets: r.extra_snippets || undefined,
  };
}

/**
 * Deduplicate results by URL (first occurrence wins).
 */
function deduplicateResults(results: SearchResultFormatted[]): SearchResultFormatted[] {
  const seen = new Map<string, SearchResultFormatted>();
  for (const result of results) {
    const key = toDedupeKey(result.url);
    if (key !== null && !seen.has(key)) {
      seen.set(key, result);
    }
  }
  return Array.from(seen.values());
}

/**
 * Fetch AI summary from Brave Summarizer API (best-effort, free).
 */
async function fetchSummary(
  summarizerKey: string,
  signal?: AbortSignal
): Promise<string | null> {
  const cached = summarizerCache.get(summarizerKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.search.brave.com/res/v1/summarizer/search?key=${encodeURIComponent(summarizerKey)}&entity_info=false`;
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: braveHeaders(),
      signal,
    }, 1);

    const data: BraveSummarizerResponse = await response.json();

    let summaryText = "";
    if (data.summary && Array.isArray(data.summary)) {
      summaryText = data.summary
        .filter((s) => s.type === "token" || s.type === "text")
        .map((s) => s.data)
        .join("");
    }

    if (summaryText) {
      summarizerCache.set(summarizerKey, summaryText);
      return summaryText;
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Tavily API execution
// =============================================================================

/**
 * Execute a search against the Tavily API.
 * Returns a CachedSearchResult with normalized, deduplicated results.
 */
async function executeTavilySearch(
  params: { query: string; freshness: string | null; domain?: string; wantSummary: boolean },
  signal?: AbortSignal
): Promise<{ results: CachedSearchResult; latencyMs: number; rateLimit?: RateLimitInfo }> {
  const requestBody: Record<string, unknown> = {
    query: params.query,
    max_results: 10,
    search_depth: "basic",
  };

  const tavilyTimeRange = mapFreshnessToTavily(params.freshness);
  if (tavilyTimeRange) {
    requestBody.time_range = tavilyTimeRange;
  }

  if (params.domain) {
    requestBody.include_domains = [params.domain];
  }

  if (params.wantSummary) {
    requestBody.include_answer = true;
  }

  const timed = await fetchWithRetryTimed("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getTavilyApiKey()}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  }, 2);

  const data: TavilySearchResponse = await timed.response.json();
  const normalized = data.results.map(normalizeTavilyResult);
  const deduplicated = deduplicateResults(normalized);

  return {
    results: {
      results: deduplicated,
      summaryText: data.answer || undefined,
      queryCorrected: false,
      moreResultsAvailable: false,
    },
    latencyMs: timed.latencyMs,
    rateLimit: timed.rateLimit,
  };
}

// =============================================================================
// Ollama API execution
// =============================================================================

interface OllamaWebSearchResult {
  title: string;
  url: string;
  content: string;
}

interface OllamaWebSearchResponse {
  results: OllamaWebSearchResult[];
}

/**
 * Execute a search against the Ollama web_search API.
 * Returns a CachedSearchResult with normalized, deduplicated results.
 */
async function executeOllamaSearch(
  params: { query: string; count: number },
  signal?: AbortSignal
): Promise<{ results: CachedSearchResult; latencyMs: number; rateLimit?: RateLimitInfo }> {
  const timed = await fetchWithRetryTimed("https://ollama.com/api/web_search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getOllamaApiKey()}`,
    },
    body: JSON.stringify({ query: params.query, max_results: params.count }),
    signal,
  }, 2);

  const data: OllamaWebSearchResponse = await timed.response.json();
  const normalized: SearchResultFormatted[] = (data.results || []).map(r => ({
    title: r.title || "(untitled)",
    url: r.url,
    description: r.content || "",
  }));
  const deduplicated = deduplicateResults(normalized);

  return {
    results: {
      results: deduplicated,
      queryCorrected: false,
      moreResultsAvailable: false,
    },
    latencyMs: timed.latencyMs,
    rateLimit: timed.rateLimit,
  };
}

// =============================================================================
// Tool Registration
// =============================================================================

export function registerSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search-the-web",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Returns top results with titles, URLs, descriptions, " +
      "extra contextual snippets, result ages, and optional AI summary. " +
      "Supports freshness filtering, domain filtering, and auto-detects recency-sensitive queries.",
    promptSnippet: "Search the web for information",
    promptGuidelines: [
      "Use this tool when the user asks about current events, facts, or external knowledge not in the codebase.",
      "Always provide the search query to the user in your response.",
      "Limit to 3-5 results unless more context is needed.",
      "Use freshness='week' or 'month' for queries about recent events, releases, or updates.",
      "Use the fetch_page tool to read the full content of promising URLs from search results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (e.g., 'latest AI news')" }),
      count: Type.Optional(
        Type.Number({ minimum: 1, maximum: 10, default: 5, description: "Number of results to return (default: 5)" })
      ),
      freshness: Type.Optional(
        StringEnum(["auto", "day", "week", "month", "year"] as const, {
          description:
            "Filter by recency. 'auto' (default) detects from query. 'day'=past 24h, 'week'=past 7d, 'month'=past 30d, 'year'=past 365d.",
        })
      ),
      domain: Type.Optional(
        Type.String({
          description: "Limit results to a specific domain (e.g., 'stackoverflow.com', 'github.com')",
        })
      ),
      summary: Type.Optional(
        Type.Boolean({
          description: "Request an AI-generated summary of the search results (default: false). Adds latency but provides a concise answer.",
          default: false,
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Search cancelled." }], details: undefined as unknown };
      }

      // ------------------------------------------------------------------
      // Resolve search provider
      // ------------------------------------------------------------------
      const provider = resolveSearchProvider();
      if (!provider) {
        return {
          content: [{ type: "text", text: "Web search unavailable: No search API key is set. Use secure_env_collect to set TAVILY_API_KEY, BRAVE_API_KEY, or OLLAMA_API_KEY." }],
          isError: true,
          details: { errorKind: "auth_error", error: "No search API key set" } satisfies Partial<SearchDetails>,
        };
      }

      const count = params.count ?? 5;
      const wantSummary = params.summary ?? false;

      // ------------------------------------------------------------------
      // Resolve freshness (shared — Brave format, converted for Tavily later)
      // ------------------------------------------------------------------
      let freshness: string | null = null;
      if (params.freshness && params.freshness !== "auto") {
        const freshnessMap: Record<string, string> = {
          day: "pd", week: "pw", month: "pm", year: "py",
        };
        freshness = freshnessMap[params.freshness] || null;
      } else {
        freshness = detectFreshness(params.query);
      }

      // ------------------------------------------------------------------
      // Handle domain filter (provider-specific)
      // ------------------------------------------------------------------
      let effectiveQuery = params.query;
      if (provider === "brave" && params.domain) {
        if (!effectiveQuery.toLowerCase().includes("site:")) {
          effectiveQuery = `site:${params.domain} ${effectiveQuery}`;
        }
      }
      // Tavily uses include_domains in request body — no query modification

      // ------------------------------------------------------------------
      // Cache lookup (provider-prefixed key)
      // ------------------------------------------------------------------
      const cacheKey = normalizeQuery(effectiveQuery) + `|f:${freshness || ""}|s:${wantSummary}|p:${provider}`;

      // ── Consecutive duplicate search guard (#949, #1671) ─────────────────
      // If the LLM keeps calling the same search query, break the loop
      // with an explicit warning instead of returning the same results.
      // After the threshold is hit, do NOT reset the state — this keeps the
      // guard armed so every subsequent duplicate immediately re-triggers it,
      // preventing the "sawtooth" pattern where resetting allowed infinite loops
      // with brief interruptions every MAX_CONSECUTIVE_DUPES+1 calls.
      if (cacheKey === lastSearchKey) {
        consecutiveDupeCount++;
        if (consecutiveDupeCount >= MAX_CONSECUTIVE_DUPES) {
          return {
            content: [{ type: "text" as const, text: `⚠️ Search loop detected: the query "${params.query}" has been searched ${consecutiveDupeCount + 1} times consecutively with identical results. The information you need is already in the previous search results above. Stop searching and use those results to proceed with your task.` }],
            isError: true,
            details: { errorKind: "search_loop", error: "Consecutive duplicate search detected" } satisfies Partial<SearchDetails>,
          };
        }
      } else {
        lastSearchKey = cacheKey;
        consecutiveDupeCount = 0;
      }

      const cached = searchCache.get(cacheKey);

      if (cached) {
        const limited = cached.results.slice(0, count);

        let summaryText: string | undefined;
        if (wantSummary) {
          if (cached.summaryText) {
            summaryText = cached.summaryText;
          } else if (cached.summarizerKey) {
            summaryText = (await fetchSummary(cached.summarizerKey, signal)) ?? undefined;
          }
        }

        const formatOpts: FormatSearchOptions = {
          cached: true,
          summary: summaryText,
          queryCorrected: cached.queryCorrected,
          originalQuery: cached.originalQuery,
          correctedQuery: cached.correctedQuery,
          moreResultsAvailable: cached.moreResultsAvailable,
        };

        const output = formatSearchResults(params.query, limited, formatOpts);

        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let content = truncation.content;
        if (truncation.truncated) {
          const tempFile = await (pi as any).writeTempFile(output, { prefix: "web-search-" });
          content += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full results: ${tempFile}]`;
        }

        const details: SearchDetails = {
          query: params.query,
          effectiveQuery,
          results: limited,
          count: limited.length,
          cached: true,
          freshness: freshness || "none",
          hasSummary: !!summaryText,
          queryCorrected: cached.queryCorrected,
          originalQuery: cached.originalQuery,
          correctedQuery: cached.correctedQuery,
          moreResultsAvailable: cached.moreResultsAvailable,
          provider,
        };

        return { content: [{ type: "text", text: content }], details };
      }

      onUpdate?.({ content: [{ type: "text", text: `Searching for "${params.query}"...` }], details: undefined as unknown });

      try {
        // ------------------------------------------------------------------
        // Provider-specific fetch
        // ------------------------------------------------------------------
        let searchResult: CachedSearchResult;
        let latencyMs: number | undefined;
        let rateLimit: RateLimitInfo | undefined;

        if (provider === "tavily") {
          const tavilyResult = await executeTavilySearch(
            { query: params.query, freshness, domain: params.domain, wantSummary },
            signal
          );
          searchResult = tavilyResult.results;
          latencyMs = tavilyResult.latencyMs;
          rateLimit = tavilyResult.rateLimit;
        } else if (provider === "ollama") {
          const ollamaResult = await executeOllamaSearch(
            { query: params.query, count: 10 },
            signal
          );
          searchResult = ollamaResult.results;
          latencyMs = ollamaResult.latencyMs;
          rateLimit = ollamaResult.rateLimit;
        } else {
          // ================================================================
          // BRAVE PATH (unchanged API logic)
          // ================================================================
          const url = new URL("https://api.search.brave.com/res/v1/web/search");
          url.searchParams.append("q", effectiveQuery);
          url.searchParams.append("count", "10"); // Extra for dedup headroom
          url.searchParams.append("extra_snippets", "true");
          url.searchParams.append("text_decorations", "false");

          if (freshness) {
            url.searchParams.append("freshness", freshness);
          }
          if (wantSummary) {
            url.searchParams.append("summary", "1");
          }

          const timed = await fetchWithRetryTimed(url.toString(), {
            method: "GET",
            headers: braveHeaders(),
            signal,
          }, 2);

          const data: BraveSearchResponse = await timed.response.json();
          const rawResults: BraveWebResult[] = data.web?.results ?? [];
          const summarizerKey: string | undefined = data.summarizer?.key;

          // Extract spellcheck/correction info
          const queryInfo = data.query;
          const queryCorrected = !!(queryInfo?.altered && queryInfo.altered !== queryInfo.original);
          const originalQuery = queryCorrected ? (queryInfo?.original ?? params.query) : undefined;
          const correctedQuery = queryCorrected ? queryInfo?.altered : undefined;
          const moreResultsAvailable = queryInfo?.more_results_available ?? false;

          // Normalize, deduplicate
          const normalized = rawResults.map(normalizeBraveResult);
          const deduplicated = deduplicateResults(normalized);

          searchResult = {
            results: deduplicated,
            summarizerKey,
            queryCorrected,
            originalQuery,
            correctedQuery,
            moreResultsAvailable,
          };
          latencyMs = timed.latencyMs;
          rateLimit = timed.rateLimit;
        }

        // ------------------------------------------------------------------
        // Shared post-fetch: cache, summary, format, return
        // ------------------------------------------------------------------
        searchCache.set(cacheKey, searchResult);
        const results = searchResult.results.slice(0, count);

        let summaryText: string | undefined;
        if (wantSummary) {
          if (searchResult.summaryText) {
            summaryText = searchResult.summaryText;
          } else if (searchResult.summarizerKey) {
            summaryText = (await fetchSummary(searchResult.summarizerKey, signal)) ?? undefined;
          }
        }

        const formatOpts: FormatSearchOptions = {
          summary: summaryText,
          queryCorrected: searchResult.queryCorrected,
          originalQuery: searchResult.originalQuery,
          correctedQuery: searchResult.correctedQuery,
          moreResultsAvailable: searchResult.moreResultsAvailable,
        };

        const output = formatSearchResults(params.query, results, formatOpts);

        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let content = truncation.content;

        if (truncation.truncated) {
          const tempFile = await (pi as any).writeTempFile(output, { prefix: "web-search-" });
          content += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full results: ${tempFile}]`;
        }

        const details: SearchDetails = {
          query: params.query,
          effectiveQuery,
          results,
          count: results.length,
          cached: false,
          freshness: freshness || "none",
          hasSummary: !!summaryText,
          latencyMs,
          rateLimit,
          queryCorrected: searchResult.queryCorrected,
          originalQuery: searchResult.originalQuery,
          correctedQuery: searchResult.correctedQuery,
          moreResultsAvailable: searchResult.moreResultsAvailable,
          provider,
        };

        return { content: [{ type: "text", text: content }], details };
      } catch (error) {
        const classified = classifyError(error);
        return {
          content: [{ type: "text", text: `Search failed: ${classified.message}` }],
          details: {
            errorKind: classified.kind,
            error: classified.message,
            retryAfterMs: classified.retryAfterMs,
            query: params.query,
            provider,
          } satisfies Partial<SearchDetails>,
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("search-the-web "));
      text += theme.fg("muted", `"${args.query}"`);

      const meta: string[] = [];
      if (args.count && args.count !== 5) meta.push(`${args.count} results`);
      if (args.freshness && args.freshness !== "auto") meta.push(`freshness:${args.freshness}`);
      if (args.domain) meta.push(`site:${args.domain}`);
      if (args.summary) meta.push("+ summary");
      if (meta.length > 0) {
        text += " " + theme.fg("dim", `(${meta.join(", ")})`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SearchDetails | undefined;
      if (details?.errorKind || details?.error) {
        const kindTag = details.errorKind ? theme.fg("dim", ` [${details.errorKind}]`) : "";
        return new Text(theme.fg("error", `✗ ${details.error ?? "Search failed"}`) + kindTag, 0, 0);
      }

      const providerTag = details?.provider ? theme.fg("dim", ` [${details.provider}]`) : "";
      const cacheTag = details?.cached ? theme.fg("dim", " [cached]") : "";
      const freshTag = details?.freshness && details.freshness !== "none"
        ? theme.fg("dim", ` [${details.freshness}]`)
        : "";
      const summaryTag = details?.hasSummary ? theme.fg("dim", " [+summary]") : "";
      const latencyTag = details?.latencyMs ? theme.fg("dim", ` ${details.latencyMs}ms`) : "";
      const correctedTag = details?.queryCorrected
        ? theme.fg("warning", ` [corrected→"${details.correctedQuery}"]`)
        : "";

      let text = theme.fg("success", `✓ ${details?.count ?? 0} results for "${details?.query}"`) +
        providerTag + cacheTag + freshTag + summaryTag + latencyTag + correctedTag;

      if (expanded && details?.results) {
        text += "\n\n";
        for (const r of details.results.slice(0, 3)) {
          const age = r.age ? theme.fg("dim", ` (${r.age})`) : "";
          text += `${theme.bold(r.title)}${age}\n${r.url}\n${r.description}\n\n`;
        }
        if (details.results.length > 3) {
          text += theme.fg("dim", `... and ${details.results.length - 3} more`);
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
