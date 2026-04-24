/**
 * Remote Questions — shared HTTP client
 *
 * Centralizes timeout, error handling, and JSON serialization logic
 * used by all channel adapters (Discord, Slack, Telegram).
 */

import { ProxyAgent } from "undici";
import { PER_REQUEST_TIMEOUT_MS } from "./types.js";

export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return "<REDACTED>";
  }
}

/**
 * Check whether a target URL should bypass the proxy based on the
 * NO_PROXY / no_proxy environment variable.
 *
 * Supports comma-separated host patterns with optional leading-dot
 * suffix matching (e.g. `.example.com` matches `sub.example.com`).
 */
export function shouldBypassProxy(targetUrl: string, noProxy?: string): boolean {
  if (!noProxy) return false;

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return false;
  }

  const patterns = noProxy.split(",").map((p) => p.trim()).filter(Boolean);
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern === hostname) return true;
    if (pattern.startsWith(".")) {
      const suffix = pattern.slice(1);
      if (hostname === suffix || hostname.endsWith(pattern)) return true;
    }
  }

  return false;
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
  /** Pre-configured ProxyAgent instance (preferred over proxyUrl for reuse). */
  agent?: ProxyAgent;
  /** When true and proxyUrl is used, disable TLS certificate verification for the proxy tunnel. */
  proxyTlsRejectUnauthorized?: boolean;
}

/**
 * Makes an HTTP request with standardized timeout, error handling, and JSON
 * serialization.
 *
 * - Sets `AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)` on every request.
 * - Serializes `body` as JSON and sets Content-Type when provided.
 * - Returns `{}` for 204 No Content responses.
 * - Truncates error response bodies to `safeErrorLength` chars (default 200).
 * - Supports HTTP/HTTPS proxy via `proxyUrl` option using undici's ProxyAgent,
 *   or a pre-created `agent` for connection reuse.
 * - Respects NO_PROXY / no_proxy environment variable when `proxyUrl` is provided.
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
    agent,
    proxyTlsRejectUnauthorized,
  } = options;

  if (agent && proxyUrl) {
    throw new Error(`${errorLabel}: agent and proxyUrl are mutually exclusive; pass one or the other`);
  }

  const headers: Record<string, string> = {};
  if (authScheme && authToken) {
    headers["Authorization"] = `${authScheme} ${authToken}`;
  }

  const init: RequestInit & { dispatcher?: ProxyAgent } = {
    method,
    headers,
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  };

  let agentToClose: ProxyAgent | undefined;

  // Use pre-configured agent if provided
  if (agent) {
    init.dispatcher = agent;
  } else if (proxyUrl) {
    // Respect NO_PROXY environment variable
    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    if (!shouldBypassProxy(url, noProxy)) {
      try {
        // Validate proxy URL before creating agent
        const _validated = new URL(proxyUrl);
        const agent = proxyTlsRejectUnauthorized === false
          ? new ProxyAgent({ uri: proxyUrl, proxyTls: { rejectUnauthorized: false } })
          : new ProxyAgent(proxyUrl);
        init.dispatcher = agent;
        agentToClose = agent;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        throw new Error(`${errorLabel}: Failed to configure proxy: ${errorMessage}`);
      }
    }
  }

  if (body !== undefined) {
    headers["Content-Type"] = contentType ?? "application/json";
    init.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, init);

    if (response.status === 204) {
      return {};
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const safeText =
        text.length > safeErrorLength
          ? text.slice(0, safeErrorLength) + "…"
          : text;
      throw new Error(`${errorLabel} HTTP ${response.status}: ${safeText}`);
    }

    const data = await response.json();
    return data;
  } finally {
    if (agentToClose) await agentToClose.close().catch(() => {});
  }
}
