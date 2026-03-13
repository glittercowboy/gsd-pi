import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import homepage from "../public/index.html";
import { startPipeline } from "./server/pipeline";
import { handleFsRequest } from "./server/fs-api";
import { handleDialogRequest } from "./server/dialog-api";
import { handleGitRequest } from "./server/git-api";
import { handleRecentProjectsRequest, addRecentProject } from "./server/recent-projects";
import { handleSettingsRequest } from "./server/settings-api";
import { handleAssetsRequest } from "./server/assets-api";
import { handleSessionStatusRequest } from "./server/session-status-api";
import { handleProxyRequest } from "./server/proxy-api";
import { handleUatResultsRequest } from "./server/uat-results-api";
import { handleGsdFileRequest } from "./server/gsd-file-api";

const repoRoot = resolve(import.meta.dir, "../../..");

// Start file-to-state pipeline with WebSocket server (before server so fetch can reference it)
const pipeline = await startPipeline({
  planningDir: resolve(repoRoot, ".gsd"),
  wsPort: 4001,
});
console.log("File-to-state pipeline running. WebSocket on :4001");

const server = Bun.serve({
  port: 4000,
  routes: {
    "/": homepage,
  },
  development: {
    hmr: true,
    console: true,
  },
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Route /api/fs/* to file system handler
    if (pathname.startsWith("/api/fs/")) {
      const response = await handleFsRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/dialog/* to native dialog handler
    if (pathname.startsWith("/api/dialog/")) {
      const response = await handleDialogRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/git/* to git log handler
    if (pathname.startsWith("/api/git/")) {
      const response = await handleGitRequest(req, url, repoRoot);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/projects/* to recent projects handler
    if (pathname.startsWith("/api/projects/")) {
      const response = await handleRecentProjectsRequest(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/settings to settings handler
    if (pathname.startsWith("/api/settings")) {
      const response = await handleSettingsRequest(req, url, pipeline.getPlanningDir());
      if (response) return addCorsHeaders(response);
    }

    // Route /api/session/* to session status handler
    if (pathname.startsWith("/api/session/")) {
      const response = await handleSessionStatusRequest(req, url, pipeline.getPlanningDir());
      if (response) return addCorsHeaders(response);
    }

    // Route /api/assets/* to assets handler
    if (pathname.startsWith("/api/assets/")) {
      const response = await handleAssetsRequest(req, url, pipeline.getPlanningDir());
      if (response) return addCorsHeaders(response);
    }

    // Route /api/uat-results to UAT results handler
    if (pathname === "/api/uat-results") {
      const response = await handleUatResultsRequest(req, url, pipeline.getPlanningDir());
      if (response) return addCorsHeaders(response);
    }

    // Route /api/gsd-file to inline read handler
    if (pathname === "/api/gsd-file") {
      const response = await handleGsdFileRequest(req, url, pipeline.getPlanningDir(), repoRoot);
      if (response) return addCorsHeaders(response);
    }

    // Route /api/preview/* to dev server proxy
    if (pathname.startsWith("/api/preview")) {
      const response = await handleProxyRequest(req, url, pipeline.getPreviewPort());
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

        await pipeline.switchProject(planningDir);

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

    // Handle CORS preflight for API routes
    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      return addCorsHeaders(new Response(null, { status: 204 }));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Mission Control running at ${server.url}`);

// Orphan prevention: kill all gsd processes when the Bun server shuts down
const cleanup = async () => {
  console.log("[server] Shutting down — killing all gsd processes...");
  await pipeline.sessionManager.killAll();
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

/** Add CORS headers to API responses (defensive — same-origin in practice). */
function addCorsHeaders(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "http://localhost:4000");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}
