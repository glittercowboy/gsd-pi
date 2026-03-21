import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { discoverProjects } from "../../../../src/web/project-discovery-service.ts";
import { detectProjectKind } from "../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Expand leading `~/` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const root = url.searchParams.get("root");

  if (!root) {
    return Response.json(
      { error: "Missing ?root= parameter" },
      { status: 400 },
    );
  }

  const detail = url.searchParams.get("detail") === "true";

  const projects = discoverProjects(expandTilde(root), detail);
  return Response.json(projects, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

// ─── POST: create a new project directory ──────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rawDevRoot = typeof body.devRoot === "string" ? body.devRoot.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!rawDevRoot) {
      return Response.json({ error: "Missing devRoot" }, { status: 400 });
    }

    const devRoot = expandTilde(rawDevRoot);
    if (!name) {
      return Response.json({ error: "Missing project name" }, { status: 400 });
    }

    // Validate name: allow alphanumeric, hyphens, underscores, dots — no slashes or spaces
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
      return Response.json(
        { error: "Invalid name. Use letters, numbers, hyphens, underscores, and dots. Must start with a letter or number." },
        { status: 400 },
      );
    }

    if (!existsSync(devRoot)) {
      return Response.json(
        { error: `Dev root does not exist: ${devRoot}` },
        { status: 400 },
      );
    }

    const projectPath = join(devRoot, name);

    if (existsSync(projectPath)) {
      return Response.json(
        { error: `Directory already exists: ${name}` },
        { status: 409 },
      );
    }

    // Create directory and initialize git repo
    mkdirSync(projectPath, { recursive: true });
    execSync("git init", { cwd: projectPath, stdio: "ignore" });

    // Detect project kind for consistent response
    const { kind, signals } = detectProjectKind(projectPath);

    return Response.json(
      {
        name,
        path: projectPath,
        kind,
        signals,
        lastModified: Date.now(),
      },
      { status: 201 },
    );
  } catch (err) {
    return Response.json(
      { error: `Failed to create project: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
