/**
 * proxy-api.ts
 *
 * Bun fetch-forwarding proxy for the live preview feature.
 * Forwards /api/preview/* requests to the project's detected dev server.
 *
 * Key behaviors:
 * - Strips X-Frame-Options and Content-Security-Policy headers (Pitfall 2)
 * - Returns a styled HTML offline page (status 200) when port is null or fetch fails
 * - Does NOT proxy WebSocket/HMR connections (known limitation — accepted per RESEARCH.md)
 */

const OFFLINE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      background: #0a0f1e;
      color: #64748b;
      font-family: monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .message { text-align: center; }
    .port { color: #475569; font-size: 0.875em; margin-top: 0.5em; }
  </style>
</head>
<body>
  <div class="message">
    <p>Dev server offline — start your dev server to preview</p>
    <p class="port">No port configured</p>
  </div>
</body>
</html>`;

/**
 * Handle a proxy request for /api/preview/* routes.
 *
 * @param req - The incoming HTTP request
 * @param url - Parsed URL of the request
 * @param port - The detected dev server port, or null if unknown
 * @returns A Response forwarding the dev server content, or an offline HTML page
 */
export async function handleProxyRequest(
  req: Request,
  url: URL,
  port: number | null
): Promise<Response> {
  if (!port) {
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // C4: Validate port is in safe range (1024-65535) to prevent SSRF to privileged services
  if (port < 1024 || port > 65535) {
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Strip /api/preview prefix to get the target path
  const targetPath = url.pathname.replace(/^\/api\/preview/, "") || "/";
  const targetUrl = `http://localhost:${port}${targetPath}${url.search}`;

  try {
    // C4: Strip auth headers to prevent credential leakage to proxied service
    const forwardHeaders = new Headers(req.headers);
    forwardHeaders.delete("authorization");
    forwardHeaders.delete("cookie");

    const proxied = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    // Strip framing-restrictive headers so the iframe can load (Pitfall 2)
    const headers = new Headers(proxied.headers);
    headers.delete("x-frame-options");
    headers.delete("content-security-policy");

    // Inject <base href="/api/preview/"> into HTML responses so absolute-path
    // resources (e.g. <script src="/assets/index.js">) resolve through the proxy
    // instead of hitting the Mission Control server root directly (black iframe fix).
    const contentType = headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      let html = await proxied.text();
      html = html.replace(/(<head[^>]*>)/i, '$1<base href="/api/preview/">');
      if (!html.includes('<base href="/api/preview/">')) {
        html = html.replace(/(<html[^>]*>)/i, '$1<base href="/api/preview/">');
      }
      return new Response(html, { status: proxied.status, headers });
    }

    return new Response(proxied.body, {
      status: proxied.status,
      headers,
    });
  } catch {
    // Dev server unreachable — return offline HTML page instead of empty 503
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
