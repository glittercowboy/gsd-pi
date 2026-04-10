/**
 * Exa API 共享调用模块
 *
 * 提供 callExaCodeSearch() 和 callExaWebSearch() 函数，
 * 供 search-the-web 工具和 exa-search 扩展共同使用。
 *
 * 通过 Exa MCP 兼容端点通信，使用 JSON-RPC 2.0 格式，
 * 无需 API Key。
 */

const API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai",
  ENDPOINT: "/mcp",
  CODE_SEARCH_TIMEOUT_MS: 30000,
  WEB_SEARCH_TIMEOUT_MS: 25000,
} as const;

interface McpRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface McpResponse {
  jsonrpc: string;
  result?: {
    content: Array<{
      type: string;
      text: string;
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

async function callExa(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const request: McpRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINT}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Exa API error (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const responseText = await response.text();

    // Parse SSE response
    const lines = responseText.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data: McpResponse = JSON.parse(line.substring(6));
        if (data.error) {
          throw new Error(`Exa API error: ${data.error.message}`);
        }
        if (data.result?.content?.length && data.result.content[0].text) {
          return data.result.content[0].text;
        }
      }
    }

    return "";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Exa search request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface ExaCodeSearchOptions {
  query: string;
  tokensNum?: number;
}

export interface ExaWebSearchOptions {
  query: string;
  numResults?: number;
  type?: "auto" | "fast" | "deep";
  livecrawl?: "fallback" | "preferred";
  contextMaxCharacters?: number;
}

/**
 * Call Exa code context search
 * @param query Search query for code context
 * @param tokensNum Number of tokens to return (1000-50000, default 5000)
 * @param signal Optional abort signal
 */
export async function callExaCodeSearch(
  query: string,
  tokensNum: number = 5000,
  signal?: AbortSignal,
): Promise<string> {
  return callExa(
    "get_code_context_exa",
    { query, tokensNum },
    API_CONFIG.CODE_SEARCH_TIMEOUT_MS,
    signal,
  );
}

/**
 * Call Exa web search
 * @param opts Search options
 * @param signal Optional abort signal
 */
export async function callExaWebSearch(
  query: string,
  opts?: Omit<ExaWebSearchOptions, "query">,
  signal?: AbortSignal,
): Promise<string> {
  return callExa(
    "web_search_exa",
    {
      query,
      type: opts?.type ?? "auto",
      numResults: opts?.numResults ?? 8,
      livecrawl: opts?.livecrawl ?? "fallback",
      contextMaxCharacters: opts?.contextMaxCharacters,
    },
    API_CONFIG.WEB_SEARCH_TIMEOUT_MS,
    signal,
  );
}
