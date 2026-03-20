import { resolve, dirname, basename } from "node:path";
import { access } from "node:fs/promises";
import homepage from "../public/index.html";
import { startPipeline } from "./server/pipeline";
import type { PipelineHandle } from "./server/pipeline";
import { handleFsRequest } from "./server/fs-api";
import { handleDialogRequest } from "./server/dialog-api";
import { handleGitRequest } from "./server/git-api";
import { handleRecentProjectsRequest, addRecentProject } from "./server/recent-projects";
import { handleWorkspaceRequest } from "./server/workspace-api";
import { handleSettingsRequest } from "./server/settings-api";
import { handleAssetsRequest } from "./server/assets-api";
import { handleSessionStatusRequest } from "./server/session-status-api";
import { handleProxyRequest } from "./server/proxy-api";
import { handleUatResultsRequest } from "./server/uat-results-api";
import { handleGsdFileRequest } from "./server/gsd-file-api";
import { isTrusted, writeTrustFlag } from "./server/trust-api";
import { handleClassifyIntentRequest } from "./server/classify-intent-api";
import { handleAuthRequest } from "./server/auth-api";
import { freePort } from "./server/kill-port";

const repoRoot = resolve(import.meta.dir, "../../..");
const publicDir = resolve(import.meta.dir, "../public");

const HTTP_PORT = parseInt(process.env.MC_PORT ?? "4200", 10);

// Free the HTTP port — WS ports are freed per-window as pipelines are created
await freePort(HTTP_PORT);

/** Per-window pipelines: windowId → PipelineHandle */
const windowPipelines = new Map<string, PipelineHandle>();
/** Per-window WS ports: windowId → port number */
const windowWsPorts = new Map<string, number>();
let nextWsPort = 4001;

/** Get the pipeline for a request (via X-Window-Id header). Falls back to first window. */
function getPipelineForReq(req: Request): PipelineHandle | null {
  const windowId = req.headers.get("X-Window-Id");
  if (windowId && windowPipelines.has(windowId)) {
    return windowPipelines.get(windowId)!;
  }
  // Fallback: first registered pipeline
  const first = windowPipelines.values().next().value;
  return first ?? null;
}

/** Register a window: get existing pipeline or create a new one. */
async function registerWindow(windowId: string): Promise<number> {
  if (windowWsPorts.has(windowId)) {
    return windowWsPorts.get(windowId)!;
  }
  const wsPort = nextWsPort++;
  windowWsPorts.set(windowId, wsPort);
  await freePort(wsPort);
  const pipeline = await startPipeline({
    planningDir: resolve(repoRoot, ".gsd"),
    wsPort,
  });
  windowPipelines.set(windowId, pipeline);
  console.log(`[server] Window ${windowId} registered — pipeline on WS :${wsPort}`);
  return wsPort;
}


// SECURITY NOTE — Intentional: No authentication on HTTP API endpoints.
//
// This is an accepted design decision for a desktop application:
// 1. The server binds to 127.0.0.1 only (hostname below) — not accessible from the network
// 2. The local-process threat (any process on the machine can make HTTP requests) is an
//    accepted risk for a single-user desktop app where the user controls all local processes
// 3. CORS headers restrict browser-based cross-origin access to the server's own origin
//
// If Mission Control ever becomes a multi-user or network-accessible service,
// HTTP authentication (e.g., bearer token, session cookie) would be required.
const server = Bun.serve({
  port: HTTP_PORT,
  hostname: "127.0.0.1",
  routes: {
    "/": homepage,
  },
  development: process.env.MC_NO_HMR ? false : { hmr: true, console: true },
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Route /api/auth/* to auth handler
    if (pathname.startsWith("/api/auth/")) {
      const response = await handleAuthRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // POST /api/window/register — register a new window and get its WS port
    if (pathname === "/api/window/register" && req.method === "POST") {
      try {
        const body = await req.json() as { windowId?: string };
        if (!body.windowId) {
          return addCorsHeaders(Response.json({ error: "windowId required" }, { status: 400 }));
        }
        const wsPort = await registerWindow(body.windowId);
        return addCorsHeaders(Response.json({ wsPort }));
      } catch (err: any) {
        return addCorsHeaders(Response.json({ error: err.message }, { status: 500 }));
      }
    }

    // Route /api/fs/* to file system handler
    // allowedRoot is the current project root so read/write are scoped to the open project.
    // list and detect-project ignore allowedRoot (no root restriction on browsing).
    if (pathname.startsWith("/api/fs/")) {
      const projectRoot = resolve(getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd"), "..");
      const response = await handleFsRequest(req, url, projectRoot);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/dialog/* to native dialog handler
    if (pathname.startsWith("/api/dialog/")) {
      const response = await handleDialogRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/git/* to git log handler
    if (pathname.startsWith("/api/git/")) {
      const p72 = getPipelineForReq(req); const projectRoot = dirname(p72?.getPlanningDir() ?? resolve(repoRoot, ".gsd"));
      const response = await handleGitRequest(req, url, projectRoot);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/projects/* to recent projects handler
    if (pathname.startsWith("/api/projects/")) {
      const response = await handleRecentProjectsRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/workspace/* to workspace handler
    if (pathname.startsWith("/api/workspace/")) {
      const response = await handleWorkspaceRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/settings to settings handler
    if (pathname.startsWith("/api/settings")) {
      const response = await handleSettingsRequest(req, url, getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd"));
      if (response) return addCorsHeaders(response);
    }

    // Route /api/session/* to session status handler
    if (pathname.startsWith("/api/session/")) {
      const response = await handleSessionStatusRequest(req, url, getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd"));
      if (response) return addCorsHeaders(response);
    }

    // Route /api/assets/* to assets handler
    if (pathname.startsWith("/api/assets/")) {
      // Assets live in <projectRoot>/assets/, not inside .gsd/
      const response = await handleAssetsRequest(req, url, resolve(getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd"), ".."));
      if (response) return addCorsHeaders(response);
    }

    // Route /api/uat-results to UAT results handler
    if (pathname === "/api/uat-results") {
      const response = await handleUatResultsRequest(req, url, getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd"));
      if (response) return addCorsHeaders(response);
    }

    // Route /api/gsd-file to inline read handler
    if (pathname === "/api/gsd-file") {
      const response = await handleGsdFileRequest(req, url, getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd"), repoRoot);
      if (response) return addCorsHeaders(response);
    }

    // POST /api/preview/port — set proxy port directly (used by tests and manual trigger)
    if (pathname === "/api/preview/port" && req.method === "POST") {
      const body = await req.json() as { port?: number };
      if (typeof body.port === "number") {
        getPipelineForReq(req)?.setPreviewPort(body.port);
        return addCorsHeaders(Response.json({ ok: true, port: body.port }));
      }
      return addCorsHeaders(Response.json({ error: "port required" }, { status: 400 }));
    }

    // Route /api/preview/* to dev server proxy
    if (pathname.startsWith("/api/preview")) {
      const response = await handleProxyRequest(req, url, getPipelineForReq(req)?.getPreviewPort() ?? 0);
      return addCorsHeaders(response);
    }

    // POST /api/project/switch — switch to a different project directory
    if (pathname === "/api/project/switch" && req.method === "POST") {
      try {
        const body = await req.json() as { path?: string };
        if (!body.path) {
          return addCorsHeaders(
            Response.json({ error: "path field required" }, { status: 400 })
          );
        }

        const projectPath = resolve(body.path);

        // Validate directory exists
        try {
          await access(projectPath);
        } catch {
          return addCorsHeaders(
            Response.json(
              { error: "Directory does not exist" },
              { status: 400 }
            )
          );
        }

        // Always pass .gsd/ path — pipeline derives repoRoot as parent.
        // If .gsd/ doesn't exist yet, buildFullState returns empty/default state.
        const planningDir = resolve(projectPath, ".gsd");
        let hasPlanningDir = false;
        try {
          await access(planningDir);
          hasPlanningDir = true;
        } catch {
          // No .gsd/ yet — new project
        }

        await getPipelineForReq(req)?.switchProject(planningDir);

        // Record in recent projects
        await addRecentProject({
          path: projectPath.replace(/\\/g, "/"),
          name: basename(projectPath),
          lastOpened: Date.now(),
          isGsdProject: hasPlanningDir,
        });

        return addCorsHeaders(
          Response.json({ switched: true, path: projectPath.replace(/\\/g, "/") })
        );
      } catch (err: any) {
        const status = err.message?.includes("Cannot switch") || err.message?.includes("already in progress") ? 409 : 500;
        return addCorsHeaders(
          Response.json({ error: err.message || "Switch failed" }, { status })
        );
      }
    }

    // GET /api/trust-status — check if current project has been trusted (PERM-02)
    if (pathname === "/api/trust-status") {
      const gsdDir = getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd");
      const trusted = await isTrusted(gsdDir);
      return addCorsHeaders(
        Response.json({ trusted, gsdDir })
      );
    }

    // POST /api/classify-intent — classify Builder mode message intent (BUILDER-04)
    if (pathname === "/api/classify-intent") {
      const response = await handleClassifyIntentRequest(req);
      return addCorsHeaders(response);
    }

    // POST /api/trust — write trust flag for a project (PERM-02)
    if (pathname === "/api/trust" && req.method === "POST") {
      const body = await req.json() as { dir?: string };
      const gsdDir = body.dir ?? getPipelineForReq(req)?.getPlanningDir() ?? resolve(repoRoot, ".gsd");
      await writeTrustFlag(gsdDir);
      return addCorsHeaders(Response.json({ ok: true }));
    }

    // Handle CORS preflight for API routes
    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      return addCorsHeaders(new Response(null, { status: 204 }));
    }

    // Serve static files from public/ directory (assets, fonts, etc.)
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      const filePath = resolve(publicDir, pathname.slice(1));
      // H6: Prevent path traversal — reject if resolved path escapes public/
      if (!filePath.startsWith(publicDir)) {
        return new Response("Forbidden", { status: 403 });
      }
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Mission Control running at ${server.url}`);

// Orphan prevention: kill all gsd processes when the Bun server shuts down
const cleanup = async () => {
  console.log("[server] Shutting down — killing all gsd processes...");
  for (const pipeline of windowPipelines.values()) {
    await pipeline.sessionManager.killAll();
  }
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

/** Add CORS headers to API responses (defensive — same-origin in practice). */
function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", `http://127.0.0.1:${HTTP_PORT}`);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Window-Id");
  return new Response(response.body, { status: response.status, headers });
}
