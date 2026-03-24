import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { webPreferencesPath } from "../../../../src/app-paths.ts";
import { discoverProjects } from "../../../../src/web/project-discovery-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shape of persisted web preferences. */
interface WebPreferences {
  devRoot?: string;
  lastActiveProject?: string;
}

/** Expand leading `~/` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * POST /api/switch-root
 *
 * Validates the new root path, persists it as the `devRoot` preference,
 * and returns the discovered projects under the new root.
 *
 * Request body: { "devRoot": "/absolute/path" }
 * Response:     { "devRoot": "/resolved/path", "projects": [...] }
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rawDevRoot = typeof body.devRoot === "string" ? body.devRoot.trim() : "";

    if (!rawDevRoot) {
      return Response.json(
        { error: "Missing devRoot in request body" },
        { status: 400 },
      );
    }

    const expanded = expandTilde(rawDevRoot);
    const resolved = resolve(expanded);

    // Validate: path must exist
    if (!existsSync(resolved)) {
      return Response.json(
        { error: `Path does not exist: ${resolved}` },
        { status: 400 },
      );
    }

    // Validate: path must be a directory
    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        return Response.json(
          { error: `Not a directory: ${resolved}` },
          { status: 400 },
        );
      }
    } catch {
      return Response.json(
        { error: `Cannot access path: ${resolved}` },
        { status: 400 },
      );
    }

    // Read existing preferences and merge
    let existing: WebPreferences = {};
    try {
      if (existsSync(webPreferencesPath)) {
        existing = JSON.parse(readFileSync(webPreferencesPath, "utf-8"));
      }
    } catch {
      // Corrupt file — start fresh
    }

    const prefs: WebPreferences = {
      ...existing,
      devRoot: resolved,
      // Clear last active project since we're changing the root
      lastActiveProject: undefined,
    };

    // Ensure parent directory exists
    const dir = dirname(webPreferencesPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(webPreferencesPath, JSON.stringify(prefs, null, 2), "utf-8");

    // Discover projects under the new root
    const projects = discoverProjects(resolved, true);

    return Response.json({
      devRoot: resolved,
      projects,
    });
  } catch (err) {
    return Response.json(
      { error: `Failed to switch root: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
