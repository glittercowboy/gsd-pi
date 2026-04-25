import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { requireProjectCwd } from "../../../../src/web/bridge-service.ts";
import { resolveSecurePath } from "../../../lib/secure-path.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 256 * 1024; // 256KB
const MAX_PROJECT_DEPTH = 6;

/** Directories to skip when listing the project root tree */
const PROJECT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  ".output",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".svelte-kit",
  ".nuxt",
  ".parcel-cache",
]);

type RootMode = "gsd" | "project";

interface FileNode {
  name: string;
  type: "file" | "directory";
  children?: FileNode[];
}

function getGsdRoot(projectCwd: string): string {
  return join(projectCwd, ".gsd");
}

function getRootForMode(mode: RootMode, projectCwd: string): string {
  return mode === "project" ? projectCwd : getGsdRoot(projectCwd);
}

function buildTree(dirPath: string, skipDirs?: Set<string>, depth = 0, maxDepth = Infinity): FileNode[] {
  if (!existsSync(dirPath)) return [];
  if (depth >= maxDepth) return [];

  const entries = readdirSync(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      if (skipDirs?.has(entry.name)) continue;
      const fullPath = join(dirPath, entry.name);
      nodes.push({
        name: entry.name,
        type: "directory",
        children: buildTree(fullPath, skipDirs, depth + 1, maxDepth),
      });
    } else if (entry.isFile()) {
      nodes.push({
        name: entry.name,
        type: "file",
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const pathParam = searchParams.get("path");
  const rootParam = (searchParams.get("root") ?? "gsd") as RootMode;

  if (rootParam !== "gsd" && rootParam !== "project") {
    return Response.json(
      { error: `Invalid root: must be "gsd" or "project"` },
      { status: 400 },
    );
  }

  const projectCwd = requireProjectCwd(request);
  const root = getRootForMode(rootParam, projectCwd);
  const headers = { "Cache-Control": "no-store" };

  // Mode A: return directory tree
  if (!pathParam) {
    if (!existsSync(root)) {
      return Response.json({ tree: [] }, { headers });
    }
    const skipDirs = rootParam === "project" ? PROJECT_SKIP_DIRS : undefined;
    const maxDepth = rootParam === "project" ? MAX_PROJECT_DEPTH : Infinity;
    return Response.json({ tree: buildTree(root, skipDirs, 0, maxDepth) }, { headers });
  }

  // Mode B: return file content
  const resolvedPath = resolveSecurePath(pathParam, root);
  if (!resolvedPath) {
    const label = rootParam === "project" ? "project root" : ".gsd/";
    return Response.json(
      { error: `Invalid path: path must be relative within ${label} and cannot contain '..' or start with '/'` },
      { status: 400, headers },
    );
  }

  if (!existsSync(resolvedPath)) {
    return Response.json(
      { error: `File not found: ${pathParam}` },
      { status: 404, headers },
    );
  }

  const stat = statSync(resolvedPath);

  if (stat.isDirectory()) {
    return Response.json(
      { error: `Path is a directory, not a file: ${pathParam}` },
      { status: 400, headers },
    );
  }

  if (stat.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: `File too large: ${pathParam} (${stat.size} bytes, max ${MAX_FILE_SIZE})` },
      { status: 413, headers },
    );
  }

  const content = readFileSync(resolvedPath, "utf-8");
  return Response.json({ content }, { headers });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { path: pathParam, content, root: rootParam = "gsd" } = body as {
    path?: string;
    content?: unknown;
    root?: string;
  };

  if (rootParam !== "gsd" && rootParam !== "project") {
    return Response.json(
      { error: `Invalid root: must be "gsd" or "project"` },
      { status: 400 },
    );
  }

  if (typeof content !== "string") {
    return Response.json(
      { error: "Missing or invalid content: must be a string" },
      { status: 400 },
    );
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
    return Response.json(
      { error: `Content too large: ${Buffer.byteLength(content, "utf-8")} bytes exceeds max ${MAX_FILE_SIZE}` },
      { status: 413 },
    );
  }

  const projectCwd = requireProjectCwd(request);
  const root = getRootForMode(rootParam as RootMode, projectCwd);

  if (typeof pathParam !== "string" || pathParam.length === 0) {
    return Response.json(
      { error: "Missing or invalid path: must be a non-empty string" },
      { status: 400 },
    );
  }

  const resolvedPath = resolveSecurePath(pathParam, root);
  if (!resolvedPath) {
    const label = rootParam === "project" ? "project root" : ".gsd/";
    return Response.json(
      { error: `Invalid path: path must be relative within ${label} and cannot contain '..' or start with '/'` },
      { status: 400 },
    );
  }

  if (!existsSync(dirname(resolvedPath))) {
    return Response.json(
      { error: "Parent directory does not exist" },
      { status: 404 },
    );
  }

  writeFileSync(resolvedPath, content, "utf-8");
  return Response.json({ success: true });
}

/** PATCH — move/rename a file or directory */
export async function PATCH(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { from, to, root: rootParam = "gsd" } = body as {
    from?: string;
    to?: string;
    root?: string;
  };

  if (rootParam !== "gsd" && rootParam !== "project") {
    return Response.json(
      { error: `Invalid root: must be "gsd" or "project"` },
      { status: 400 },
    );
  }

  if (typeof from !== "string" || from.length === 0) {
    return Response.json(
      { error: "Missing or invalid 'from': must be a non-empty string" },
      { status: 400 },
    );
  }

  if (typeof to !== "string" || to.length === 0) {
    return Response.json(
      { error: "Missing or invalid 'to': must be a non-empty string" },
      { status: 400 },
    );
  }

  const projectCwd = requireProjectCwd(request);
  const root = getRootForMode(rootParam as RootMode, projectCwd);
  const label = rootParam === "project" ? "project root" : ".gsd/";

  const resolvedFrom = resolveSecurePath(from, root);
  if (!resolvedFrom) {
    return Response.json(
      { error: `Invalid 'from' path: must be relative within ${label}` },
      { status: 400 },
    );
  }

  const resolvedTo = resolveSecurePath(to, root);
  if (!resolvedTo) {
    return Response.json(
      { error: `Invalid 'to' path: must be relative within ${label}` },
      { status: 400 },
    );
  }

  if (!existsSync(resolvedFrom)) {
    return Response.json(
      { error: `Source not found: ${from}` },
      { status: 404 },
    );
  }

  if (existsSync(resolvedTo)) {
    return Response.json(
      { error: `Destination already exists: ${to}` },
      { status: 409 },
    );
  }

  if (!existsSync(dirname(resolvedTo))) {
    return Response.json(
      { error: `Destination directory does not exist: ${dirname(to)}` },
      { status: 404 },
    );
  }

  try {
    renameSync(resolvedFrom, resolvedTo);
  } catch (err) {
    return Response.json(
      { error: `Move failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  return Response.json({ success: true, from, to });
}

/** DELETE — delete a file or directory */
export async function DELETE(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const pathParam = searchParams.get("path");
  const rootParam = (searchParams.get("root") ?? "gsd") as RootMode;

  if (rootParam !== "gsd" && rootParam !== "project") {
    return Response.json(
      { error: `Invalid root: must be "gsd" or "project"` },
      { status: 400 },
    );
  }

  if (!pathParam || pathParam.length === 0) {
    return Response.json(
      { error: "Missing 'path' query parameter" },
      { status: 400 },
    );
  }

  const projectCwd = requireProjectCwd(request);
  const root = getRootForMode(rootParam, projectCwd);
  const label = rootParam === "project" ? "project root" : ".gsd/";

  const resolvedPath = resolveSecurePath(pathParam, root);
  if (!resolvedPath) {
    return Response.json(
      { error: `Invalid path: must be relative within ${label}` },
      { status: 400 },
    );
  }

  if (!existsSync(resolvedPath)) {
    return Response.json(
      { error: `Not found: ${pathParam}` },
      { status: 404 },
    );
  }

  try {
    rmSync(resolvedPath, { recursive: true });
  } catch (err) {
    return Response.json(
      { error: `Delete failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  return Response.json({ success: true });
}

/** PUT — create a new file or directory */
export async function PUT(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { path: pathParam, type = "file", root: rootParam = "gsd" } = body as {
    path?: string;
    type?: "file" | "directory";
    root?: string;
  };

  if (rootParam !== "gsd" && rootParam !== "project") {
    return Response.json(
      { error: `Invalid root: must be "gsd" or "project"` },
      { status: 400 },
    );
  }

  if (typeof pathParam !== "string" || pathParam.length === 0) {
    return Response.json(
      { error: "Missing or invalid 'path'" },
      { status: 400 },
    );
  }

  if (type !== "file" && type !== "directory") {
    return Response.json(
      { error: `Invalid type: must be "file" or "directory"` },
      { status: 400 },
    );
  }

  const projectCwd = requireProjectCwd(request);
  const root = getRootForMode(rootParam as RootMode, projectCwd);
  const label = rootParam === "project" ? "project root" : ".gsd/";

  const resolvedPath = resolveSecurePath(pathParam, root);
  if (!resolvedPath) {
    return Response.json(
      { error: `Invalid path: must be relative within ${label}` },
      { status: 400 },
    );
  }

  if (existsSync(resolvedPath)) {
    return Response.json(
      { error: `Already exists: ${pathParam}` },
      { status: 409 },
    );
  }

  if (!existsSync(dirname(resolvedPath))) {
    return Response.json(
      { error: `Parent directory does not exist: ${dirname(pathParam)}` },
      { status: 404 },
    );
  }

  try {
    if (type === "directory") {
      mkdirSync(resolvedPath);
    } else {
      writeFileSync(resolvedPath, "", "utf-8");
    }
  } catch (err) {
    return Response.json(
      { error: `Create failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  return Response.json({ success: true });
}
