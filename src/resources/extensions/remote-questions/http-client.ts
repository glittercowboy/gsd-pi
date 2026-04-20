/**
 * Remote Questions — shared HTTP client
 *
 * Centralizes timeout, error handling, and JSON serialization logic
 * used by all channel adapters (Discord, Slack, Telegram).
 */

import { ProxyAgent } from "undici";
import { PER_REQUEST_TIMEOUT_MS } from "./types.js";

const proxyAgentCache = new Map<string, ProxyAgent>();

function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return "[invalid-proxy-url]";
  }
}

export interface ApiRequestOptions {
  /** Authorization header scheme. Omit to skip the Authorization header entirely. */
  authScheme?: "Bearer" | "Bot";
  /** Token for the Authorization header. Ignored when authScheme is omitted. */
  authToken?: string;
  /** Max chars of error body to include in thrown Error. Default 200. */
  safeErrorLength?: number;
  /** Label used in error messages (e.g. "Discord API", "Slack API"). Default "HTTP". */
  errorLabel?: string;
  /** Content-Type override. Default "application/json" when body is present. */
  contentType?: string;
  /** HTTP/HTTPS proxy URL (e.g., "http://proxy.example.com:8080"). */
  proxyUrl?: string;
}

/**
 * Makes an HTTP request with standardized timeout, error handling, and JSON
 * serialization.
 *
 * - Sets `AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)` on every request.
 * - Serializes `body` as JSON and sets Content-Type when provided.
 * - Returns `{}` for 204 No Content responses.
 * - Truncates error response bodies to `safeErrorLength` chars (default 200).
 * - Supports HTTP/HTTPS proxy via `proxyUrl` option using undici's ProxyAgent.
 */
export async function apiRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<any> {
  const {
    authScheme,
    authToken,
    safeErrorLength = 200,
    errorLabel = "HTTP",
    contentType,
    proxyUrl,
  } = options;

  const headers: Record<string, string> = {};
  if (authScheme && authToken) {
    headers["Authorization"] = `${authScheme} ${authToken}`;
  }

  const init: RequestInit & { dispatcher?: ProxyAgent } = {
    method,
    headers,
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  };

  // Configure proxy if proxyUrl is provided
  if (proxyUrl) {
    let agent = proxyAgentCache.get(proxyUrl);
    if (!agent) {
      try {
        agent = new ProxyAgent(proxyUrl);
        proxyAgentCache.set(proxyUrl, agent);
      } catch (err) {
        const redactedUrl = redactProxyUrl(proxyUrl);
        const errorMessage = err instanceof Error ? err.message : String(err);
        throw new Error(`${errorLabel}: Failed to configure proxy (${redactedUrl}): ${errorMessage}`);
      }
    }
    init.dispatcher = agent;
  }

  if (body !== undefined) {
    headers["Content-Type"] = contentType ?? "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (response.status === 204) return {};

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const safeText =
      text.length > safeErrorLength
        ? text.slice(0, safeErrorLength) + "\u2026"
        : text;
    throw new Error(`${errorLabel} HTTP ${response.status}: ${safeText}`);
  }

  return response.json();
}
