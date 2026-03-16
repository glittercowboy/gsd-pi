/**
 * Assets API — upload, list, delete project assets.
 * Files stored in <planningDir>/assets/ directory.
 */

import { readdir, stat, unlink, mkdir, access } from "node:fs/promises";
import { join, extname, basename, resolve } from "node:path";

/** Allowed file extensions for upload */
export const SUPPORTED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg",
  "mp4", "webm",
  "pdf", "md", "txt",
]);

/** Maximum file size: 50MB */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** MIME type lookup by file extension */
export const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
};

function assetsDir(planningDir: string): string {
  return join(planningDir, "assets");
}

function metaFilePath(planningDir: string): string {
  return join(planningDir, "assets-meta.json");
}

async function readAssetsMeta(planningDir: string): Promise<Record<string, { category?: string }>> {
  try {
    const raw = await Bun.file(metaFilePath(planningDir)).text();
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAssetsMeta(planningDir: string, meta: Record<string, { category?: string }>): Promise<void> {
  await mkdir(assetsDir(planningDir), { recursive: true });
  await Bun.write(metaFilePath(planningDir), JSON.stringify(meta, null, 2));
}

/**
 * Generate a unique filename by appending -1, -2 suffixes if needed.
 */
async function uniqueFilename(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const base = basename(name, ext);
  let candidate = name;
  let counter = 0;

  while (true) {
    try {
      await access(join(dir, candidate));
      // File exists, try next suffix
      counter++;
      candidate = `${base}-${counter}${ext}`;
    } catch {
      // File doesn't exist, use this name
      return candidate;
    }
  }
}

/**
 * HTTP request handler for /api/assets/* routes.
 * Returns Response or null if route not matched.
 */
export async function handleAssetsRequest(
  req: Request,
  url: URL,
  planningDir: string
): Promise<Response | null> {
  const { pathname } = url;
  const dir = assetsDir(planningDir);

  // POST /api/assets/upload — upload a file
  if (pathname === "/api/assets/upload" && req.method === "POST") {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const file = formData.get("file") as File | null;
    if (!file) {
      return Response.json({ error: "No file field in form data" }, { status: 400 });
    }

    // Validate extension
    const ext = extname(file.name).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return Response.json(
        { error: `Unsupported file type: .${ext}. Allowed: ${[...SUPPORTED_EXTENSIONS].join(", ")}` },
        { status: 400 }
      );
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: `File too large: ${file.size} bytes. Maximum: ${MAX_FILE_SIZE} bytes (50MB)` },
        { status: 413 }
      );
    }

    // Ensure assets directory exists
    await mkdir(dir, { recursive: true });

    // Get unique filename
    const finalName = await uniqueFilename(dir, file.name);
    const filePath = join(dir, finalName);

    // Read category from form data
    const category = (formData.get("category") as string | null)?.trim() || "Uncategorized";

    // Write file
    const buffer = await file.arrayBuffer();
    await Bun.write(filePath, buffer);

    // Update assets meta with category
    const meta = await readAssetsMeta(planningDir);
    meta[finalName] = { category };
    await writeAssetsMeta(planningDir, meta);

    return Response.json({
      name: finalName,
      path: filePath.replace(/\\/g, "/"),
      type: ext,
      size: file.size,
      category,
    });
  }

  // GET /api/assets/list — list all assets
  if (pathname === "/api/assets/list" && req.method === "GET") {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Directory doesn't exist yet — return empty array
      return Response.json([]);
    }

    const assets = await Promise.all(
      entries.map(async (name) => {
        const filePath = join(dir, name);
        const info = await stat(filePath);
        return {
          name,
          path: filePath.replace(/\\/g, "/"),
          type: extname(name).slice(1).toLowerCase(),
          size: info.size,
          createdAt: info.birthtime.toISOString(),
        };
      })
    );

    const meta = await readAssetsMeta(planningDir);
    const enrichedAssets = assets.map((a) => ({
      ...a,
      category: meta[a.name]?.category ?? "Uncategorized",
    }));
    return Response.json(enrichedAssets);
  }

  // GET /api/assets/file/:name — serve a file
  if (pathname.startsWith("/api/assets/file/") && req.method === "GET") {
    const name = decodeURIComponent(pathname.slice("/api/assets/file/".length));

    if (!name) {
      return Response.json({ error: "No filename provided" }, { status: 400 });
    }

    // Path traversal check
    if (name.includes("..") || name.includes("\\")) {
      return Response.json({ error: "Invalid filename" }, { status: 400 });
    }

    // Only handle direct filenames (no sub-paths)
    if (name.includes("/")) {
      return Response.json({ error: "Invalid filename" }, { status: 400 });
    }

    const filePath = resolve(dir, name);
    const resolvedDir = resolve(dir);

    // Verify resolved path stays within assets directory
    if (!filePath.startsWith(resolvedDir)) {
      return Response.json({ error: "Path traversal not allowed" }, { status: 400 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const ext = extname(name).slice(1).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    return new Response(file, {
      headers: { "Content-Type": contentType },
    });
  }

  // DELETE /api/assets/:name — delete an asset
  if (pathname.startsWith("/api/assets/") && req.method === "DELETE") {
    const name = decodeURIComponent(pathname.slice("/api/assets/".length));

    if (!name) {
      return null;
    }

    // Path traversal check (before sub-path check)
    if (name.includes("..") || name.includes("\\")) {
      return Response.json({ error: "Invalid filename" }, { status: 400 });
    }

    // Skip sub-paths (only handle direct filenames)
    if (name.includes("/")) {
      return null;
    }

    const filePath = resolve(dir, name);
    const resolvedDir = resolve(dir);

    // Verify resolved path is within assets directory
    if (!filePath.startsWith(resolvedDir)) {
      return Response.json({ error: "Path traversal not allowed" }, { status: 400 });
    }

    try {
      await unlink(filePath);
      const meta = await readAssetsMeta(planningDir);
      delete meta[name];
      await writeAssetsMeta(planningDir, meta);
      return Response.json({ deleted: true, name });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // GET /api/assets/categories
  if (pathname === "/api/assets/categories" && req.method === "GET") {
    const meta = await readAssetsMeta(planningDir);
    const cats = new Set<string>();
    cats.add("Uncategorized");
    for (const entry of Object.values(meta)) {
      if (entry.category) cats.add(entry.category);
    }
    return Response.json(Array.from(cats).sort());
  }

  return null;
}
