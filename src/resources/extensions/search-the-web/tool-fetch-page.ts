/**
 * fetch_page tool — Extract clean markdown from any URL.
 *
 * v3 improvements:
 * - offset parameter for continuation reading (like file read offsets)
 * - selector parameter for Jina's X-Target-Selector (extract specific sections)
 * - Jina failure diagnostics surfaced in details
 * - Content-type awareness (JSON passthrough, PDF detection)
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";

import { LRUTTLCache } from "./cache.js";
import { fetchSimple, HttpError } from "./http.js";
import { extractDomain } from "./url-utils.js";
import { formatPageContent, type FormatPageOptions } from "./format.js";
import { getOllamaApiKey } from "./provider.js";

// =============================================================================
// Cache
// =============================================================================

interface CachedPage {
  content: string;
  title?: string;
  source: "jina" | "direct";
}

// Page content cache: max 30 entries, 15-minute TTL
const pageCache = new LRUTTLCache<CachedPage>({ max: 30, ttlMs: 900_000 });
pageCache.startPurgeInterval(120_000);

// =============================================================================
// Jina Reader
// =============================================================================

/**
 * Fetch page content via Jina Reader API.
 * Returns content + metadata, or throws with a descriptive error.
 */
async function fetchViaJina(
  url: string,
  options: { signal?: AbortSignal; selector?: string } = {}
): Promise<{ content: string; title?: string }> {
  const jinaUrl = `https://r.jina.ai/${url}`;

  const headers: Record<string, string> = {
    "Accept": "text/plain",
    "X-Return-Format": "markdown",
    "X-No-Cache": "false",
  };

  // Use Jina API key if available for higher rate limits
  const jinaKey = process.env.JINA_API_KEY;
  if (jinaKey) {
    headers["Authorization"] = `Bearer ${jinaKey}`;
  }

  // Target specific CSS selector on the page
  if (options.selector) {
    headers["X-Target-Selector"] = options.selector;
  }

  const response = await fetchSimple(jinaUrl, {
    method: "GET",
    headers,
    signal: options.signal,
    timeoutMs: 20_000,
  });

  const text = await response.text();

  // Jina returns markdown with a title line at the top
  // Format: "Title: <title>\nURL Source: <url>\n\n<content>"
  let title: string | undefined;
  let content = text;

  const titleMatch = text.match(/^Title:\s*(.+)\n/);
  if (titleMatch) {
    title = titleMatch[1].trim();
    content = text.replace(/^Title:\s*.+\n/, "");
  }

  // Strip the URL Source line
  content = content.replace(/^URL Source:\s*.+\n\n?/, "");

  // Strip Markdown images to save tokens
  content = content.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");

  // Collapse excessive whitespace
  content = content.replace(/\n{4,}/g, "\n\n\n");

  return { content: content.trim(), title };
}

/**
 * Basic fallback: fetch raw HTML and do crude text extraction.
 */
async function fetchDirectFallback(
  url: string,
  signal?: AbortSignal
): Promise<{ content: string; title?: string; contentType?: string }> {
  const response = await fetchSimple(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/json,text/plain",
      "User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)",
    },
    signal,
    timeoutMs: 15_000,
  });

  const contentType = response.headers.get("content-type") || "";

  // JSON passthrough — return formatted JSON directly
  if (contentType.includes("application/json")) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return {
        content: "```json\n" + JSON.stringify(parsed, null, 2) + "\n```",
        title: undefined,
        contentType: "application/json",
      };
    } catch {
      return { content: text, title: undefined, contentType };
    }
  }

  // Plain text passthrough
  if (contentType.includes("text/plain")) {
    const text = await response.text();
    return { content: text, title: undefined, contentType: "text/plain" };
  }

  // PDF detection — can't extract, but tell the agent
  if (contentType.includes("application/pdf")) {
    return {
      content: "[This URL is a PDF document. Content extraction is not supported for PDFs.]",
      title: undefined,
      contentType: "application/pdf",
    };
  }

  const html = await response.text();

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  // Strip tags, decode entities, collapse whitespace
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { content: text, title, contentType };
}

// =============================================================================
// Ollama Web Fetch
// =============================================================================

interface OllamaWebFetchResponse {
  title?: string;
  content?: string;
  links?: string[];
}

/**
 * Fetch page content via Ollama web_fetch API.
 * Returns content + metadata, or throws on failure.
 */
async function fetchViaOllama(
  url: string,
  signal?: AbortSignal,
): Promise<{ content: string; title?: string }> {
  const response = await fetchSimple("https://ollama.com/api/web_fetch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getOllamaApiKey()}`,
    },
    body: JSON.stringify({ url }),
    signal,
    timeoutMs: 20_000,
  });

  const data: OllamaWebFetchResponse = await response.json();

  const content = (data.content || "").trim();
  const title = data.title?.trim() || undefined;

  return { content, title };
}

// =============================================================================
// Smart Truncation
// =============================================================================

/**
 * Truncate page content to a target character count, trying to break
 * at paragraph boundaries rather than mid-sentence.
 */
function smartTruncate(
  content: string,
  maxChars: number,
  offset: number = 0
): { content: string; truncated: boolean; hasMore: boolean; nextOffset?: number } {
  // Apply offset first
  const sliced = offset > 0 ? content.slice(offset) : content;

  if (sliced.length <= maxChars) {
    return { content: sliced, truncated: false, hasMore: false };
  }

  // Find the last paragraph break before maxChars
  const window = sliced.slice(0, maxChars);
  const lastParagraph = window.lastIndexOf("\n\n");
  const lastSentence = window.lastIndexOf(". ");
  const lastNewline = window.lastIndexOf("\n");

  // Prefer paragraph > sentence > newline > hard cut
  let cutPoint = maxChars;
  if (lastParagraph > maxChars * 0.6) {
    cutPoint = lastParagraph;
  } else if (lastSentence > maxChars * 0.6) {
    cutPoint = lastSentence + 1;
  } else if (lastNewline > maxChars * 0.6) {
    cutPoint = lastNewline;
  }

  const nextOffset = offset + cutPoint;
  const hasMore = nextOffset < content.length;

  return {
    content: sliced.slice(0, cutPoint).trim() + "\n\n[... content truncated]",
    truncated: true,
    hasMore,
    nextOffset: hasMore ? nextOffset : undefined,
  };
}

// =============================================================================
// Single page fetch (shared between single and multi modes)
// =============================================================================

interface FetchPageResult {
  content: string;
  title?: string;
  source: "jina" | "direct";
  jinaError?: string;
  contentType?: string;
  originalChars: number;
}

async function fetchOnePage(
  url: string,
  options: { signal?: AbortSignal; selector?: string }
): Promise<FetchPageResult> {
  let pageContent: string;
  let pageTitle: string | undefined;
  let source: "jina" | "direct" = "jina";
  let jinaError: string | undefined;
  let contentType: string | undefined;

  try {
    const result = await fetchViaJina(url, options);
    pageContent = result.content;
    pageTitle = result.title;
  } catch (err) {
    // Capture Jina failure reason for diagnostics
    jinaError = err instanceof HttpError
      ? `Jina HTTP ${err.statusCode}`
      : (err as Error).message ?? String(err);

    // Try Ollama web_fetch as intermediate fallback if API key is available
    const ollamaKey = getOllamaApiKey();
    if (ollamaKey) {
      try {
        const ollamaResult = await fetchViaOllama(url, options.signal);
        if (ollamaResult.content && ollamaResult.content.length >= 50) {
          pageContent = ollamaResult.content;
          pageTitle = ollamaResult.title;
          source = "direct";
          return {
            content: pageContent,
            title: pageTitle,
            source,
            jinaError,
            contentType,
            originalChars: pageContent.length,
          };
        }
      } catch {
        // Ollama fetch failed too — fall through to direct
      }
    }

    source = "direct";

    const result = await fetchDirectFallback(url, options.signal);
    pageContent = result.content;
    pageTitle = result.title;
    contentType = result.contentType;
  }

  return {
    content: pageContent,
    title: pageTitle,
    source,
    jinaError,
    contentType,
    originalChars: pageContent.length,
  };
}

// =============================================================================
// Details Interface
// =============================================================================

interface FetchPageDetails {
  url: string;
  title?: string;
  charCount: number;
  originalChars?: number;
  truncated: boolean;
  cached: boolean;
  source?: "jina" | "direct";
  jinaError?: string;
  contentType?: string;
  hasMore?: boolean;
  nextOffset?: number;
  offset?: number;
  selector?: string;
  error?: string;
}

// =============================================================================
// Tool Registration
// =============================================================================

export function registerFetchPageTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_page",
    label: "Fetch Page",
    description:
      "Fetch a web page and extract its content as clean markdown. " +
      "Use this to read the full content of URLs found via search-the-web. " +
      "Uses Jina Reader for high-quality markdown extraction. " +
      "Control the amount of content returned with maxChars (default: 8000, max: 30000).",
    promptSnippet: "Fetch and extract clean content from a web page URL as markdown",
    promptGuidelines: [
      "Use fetch_page to read the content of URLs found via search-the-web when you need more detail than snippets provide.",
      "Start with the default maxChars (8000). Increase only if the first fetch lacks the detail you need.",
      "For very long pages, use a smaller maxChars and increase if needed — this saves context tokens.",
      "The extracted content is already clean markdown — no HTML tags, no navigation, no ads.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from" }),
      maxChars: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: 30000,
          default: 8000,
          description: "Maximum characters of content to return (default: 8000, max: 30000). Controls context token usage.",
        })
      ),
      offset: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "Character offset to start reading from (for continuation of truncated pages). Use the nextOffset value from a previous fetch_page result.",
        })
      ),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to extract only a specific section of the page (e.g., 'main', 'article', '.api-docs'). Reduces noise and token usage.",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Fetch cancelled." }], details: undefined as unknown };
      }

      const maxChars = params.maxChars ?? 8000;
      const offset = params.offset ?? 0;
      const url = params.url.trim();

      // Validate URL
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid URL: ${url}` }],
          isError: true,
          details: { error: "Invalid URL", url } satisfies Partial<FetchPageDetails>,
        };
      }

      // ------------------------------------------------------------------
      // Cache lookup (full content cached, offset/truncation applied after)
      // ------------------------------------------------------------------
      const cacheKey = params.selector ? `${url}|sel:${params.selector}` : url;
      const cached = pageCache.get(cacheKey);

      if (cached) {
        const trunc = smartTruncate(cached.content, maxChars, offset);
        const opts: FormatPageOptions = {
          title: cached.title,
          charCount: trunc.content.length,
          truncated: trunc.truncated,
          originalChars: trunc.truncated ? cached.content.length : undefined,
          hasMore: trunc.hasMore,
          nextOffset: trunc.nextOffset,
        };
        const output = formatPageContent(url, trunc.content, opts);

        const finalTruncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const details: FetchPageDetails = {
          url,
          title: cached.title,
          charCount: trunc.content.length,
          originalChars: cached.content.length,
          truncated: trunc.truncated,
          cached: true,
          source: cached.source,
          hasMore: trunc.hasMore,
          nextOffset: trunc.nextOffset,
          offset: offset || undefined,
        };
        return {
          content: [{ type: "text", text: finalTruncation.content }],
          details,
        };
      }

      const domain = extractDomain(url);
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${domain}...` }], details: undefined as unknown });

      // ------------------------------------------------------------------
      // Fetch page content
      // ------------------------------------------------------------------
      let result: FetchPageResult;
      try {
        result = await fetchOnePage(url, { signal, selector: params.selector });
      } catch (err) {
        const message = err instanceof HttpError
          ? `HTTP ${err.statusCode}`
          : (err as Error).message ?? String(err);
        return {
          content: [{ type: "text", text: `Failed to fetch ${domain}: ${message}` }],
          isError: true,
          details: { error: message, url } satisfies Partial<FetchPageDetails>,
        };
      }

      // Check for empty content
      if (!result.content || result.content.length < 50) {
        return {
          content: [{ type: "text", text: `Page at ${domain} returned no extractable content.` }],
          details: { url, charCount: 0, source: result.source, cached: false, truncated: false, jinaError: result.jinaError } satisfies FetchPageDetails,
        };
      }

      // Cache the full content
      pageCache.set(cacheKey, { content: result.content, title: result.title, source: result.source });

      // Smart truncate with offset
      const trunc = smartTruncate(result.content, maxChars, offset);

      const opts: FormatPageOptions = {
        title: result.title,
        charCount: trunc.content.length,
        truncated: trunc.truncated,
        originalChars: trunc.truncated ? result.originalChars : undefined,
        hasMore: trunc.hasMore,
        nextOffset: trunc.nextOffset,
      };

      const output = formatPageContent(url, trunc.content, opts);

      const finalTruncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let content = finalTruncation.content;
      if (finalTruncation.truncated) {
        const tempFile = await (pi as any).writeTempFile(output, { prefix: "fetch-page-" });
        content += `\n\n[Truncated to fit context. Full content: ${tempFile}]`;
      }

      const details: FetchPageDetails = {
        url,
        title: result.title,
        charCount: trunc.content.length,
        originalChars: result.originalChars,
        truncated: trunc.truncated,
        cached: false,
        source: result.source,
        jinaError: result.jinaError,
        contentType: result.contentType,
        hasMore: trunc.hasMore,
        nextOffset: trunc.nextOffset,
        offset: offset || undefined,
        selector: params.selector,
      };

      return {
        content: [{ type: "text", text: content }],
        details,
      };
    },

    renderCall(args, theme) {
      const domain = extractDomain(args.url);
      let text = theme.fg("toolTitle", theme.bold("fetch_page "));
      text += theme.fg("accent", domain);

      const meta: string[] = [];
      if (args.maxChars && args.maxChars !== 8000) meta.push(`max ${(args.maxChars / 1000).toFixed(0)}k`);
      if (args.offset) meta.push(`offset:${args.offset}`);
      if (args.selector) meta.push(`sel:"${args.selector}"`);
      if (meta.length > 0) {
        text += " " + theme.fg("dim", `(${meta.join(", ")})`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as FetchPageDetails | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      const domain = extractDomain(details?.url || "");
      const title = details?.title ? ` — ${details.title}` : "";
      const chars = details?.charCount ? `${(details.charCount / 1000).toFixed(1)}k chars` : "";
      const cacheTag = details?.cached ? theme.fg("dim", " [cached]") : "";
      const sourceTag = details?.source === "direct" ? theme.fg("dim", " [direct]") : "";
      const truncTag = details?.truncated && details?.originalChars
        ? theme.fg("dim", ` [${(details.originalChars / 1000).toFixed(0)}k total]`)
        : "";
      const moreTag = details?.hasMore && details?.nextOffset
        ? theme.fg("accent", ` [more→offset:${details.nextOffset}]`)
        : "";
      const jinaTag = details?.jinaError
        ? theme.fg("warning", ` [jina failed: ${details.jinaError}]`)
        : "";

      let text = theme.fg("success", `✓ ${domain}${title}`) + ` ${chars}` +
        cacheTag + sourceTag + truncTag + moreTag + jinaTag;

      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 8).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
