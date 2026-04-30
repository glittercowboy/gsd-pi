import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";
import { homedir, platform } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve the configured dev root from web preferences.
 * Returns the devRoot path if set, otherwise the user's home directory.
 */
function getDevRoot(): string {
  try {
    const prefsPath = join(homedir(), ".gsd", "web-preferences.json");
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf-8")) as Record<string, unknown>;
      if (typeof prefs.devRoot === "string" && prefs.devRoot) {
        return resolve(prefs.devRoot);
      }
    }
  } catch {
    // Fall through to default
  }
  return homedir();
}

function existingDirectories(paths: string[]): string[] {
  return paths.filter((entry) => existsSync(entry));
}

function getLinuxMountPoints(): string[] {
  const home = homedir();
  return existingDirectories([
    "/media",
    "/mnt",
    "/run/media",
    `/run/media/${home.split("/").pop()}`,
  ]);
}

function getMacMountPoints(): string[] {
  return existingDirectories(["/Volumes"]);
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  if (resolvedCandidate === resolvedRoot) return true;
  const pathToCandidate = relative(resolvedRoot, resolvedCandidate);
  return (
    Boolean(pathToCandidate) &&
    !pathToCandidate.startsWith("..") &&
    pathToCandidate !== ".." &&
    !pathToCandidate.startsWith(sep)
  );
}

/**
 * Get additional root-level directories to show as shortcuts
 * (for accessing external drives and mounted filesystems)
 */
function getAdditionalRoots(): string[] {
  const os = platform();
  if (os === "linux") {
    return getLinuxMountPoints();
  }
  if (os === "darwin") {
    return getMacMountPoints();
  }
  return [];
}

/**
 * GET /api/browse-directories?path=/some/path
 *
 * Returns the directory listing for the given path.
 * Defaults to the configured devRoot (or home directory) if no path is given.
 * Only returns directories (no files) for the folder picker use case.
 *
 * Security: Paths are restricted to the devRoot and its children. Requests
 * for paths outside devRoot are rejected with 403 to prevent full filesystem
 * enumeration.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawPath = url.searchParams.get("path");
    const devRoot = getDevRoot();
    const targetPath = rawPath ? resolve(rawPath) : devRoot;

    // Restrict browsing to devRoot and its subtree, or the home directory
    // if no devRoot is configured. Navigating to the parent of devRoot is
    // allowed (one level up) so the UI can show the devRoot in context,
    // but nothing further.
    // Also allow navigation to platform mount roots (for example, /Volumes on macOS).
    const devRootParent = dirname(devRoot);
    const additionalRoots = getAdditionalRoots();
    const isAllowedBrowsePath = (candidate: string): boolean =>
      isSameOrDescendant(candidate, devRoot) ||
      candidate === devRootParent ||
      additionalRoots.some((root) => isSameOrDescendant(candidate, root));
    const isAllowedPath = isAllowedBrowsePath(targetPath);

    if (!isAllowedPath) {
      return Response.json(
        { error: "Path outside allowed scope" },
        { status: 403 },
      );
    }

    if (!existsSync(targetPath)) {
      return Response.json(
        { error: `Path does not exist: ${targetPath}` },
        { status: 404 },
      );
    }

    const stat = statSync(targetPath);
    if (!stat.isDirectory()) {
      return Response.json(
        { error: `Not a directory: ${targetPath}` },
        { status: 400 },
      );
    }

    const parentPath = dirname(targetPath);
    // Only offer the parent navigation if it's within the allowed scope.
    const parentAllowed = parentPath !== targetPath && isAllowedBrowsePath(parentPath);
    const entries: Array<{ name: string; path: string }> = [];

    // Show mount points as quick-access when browsing from the home/dev root.
    const showMountPoints = additionalRoots.length > 0 && (targetPath === homedir() || targetPath === devRoot);

    try {
      const items = readdirSync(targetPath, { withFileTypes: true });
      for (const item of items) {
        // Only directories, skip dotfiles and common non-project dirs
        if (!item.isDirectory()) continue;
        if (item.name.startsWith(".")) continue;
        if (item.name === "node_modules") continue;

        entries.push({
          name: item.name,
          path: resolve(targetPath, item.name),
        });
      }

      // Add mount points as quick-access entries.
      if (showMountPoints) {
        for (const mp of additionalRoots) {
          if (existsSync(mp)) {
            const mpName = mp.split("/").pop() || mp;
            entries.push({
              name: mpName,
              path: mp,
            });
          }
        }
      }
    } catch {
      // Permission denied or other read error — return empty entries
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    return Response.json({
      current: targetPath,
      parent: parentAllowed ? parentPath : null,
      entries,
    });
  } catch (err) {
    return Response.json(
      { error: `Browse failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
