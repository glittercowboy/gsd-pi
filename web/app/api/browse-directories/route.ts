import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
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

/**
 * Get available mount points on Linux (external drives, removable media)
 * Returns paths like /media, /mnt, /run/media/<user>
 */
function getLinuxMountPoints(): string[] {
  const mountPoints: string[] = [];
  const home = homedir();

  const standardMounts = ["/media", "/mnt", "/run/media"];

  for (const mp of standardMounts) {
    if (existsSync(mp)) {
      mountPoints.push(mp);
    }
  }

  const runMediaUser = `/run/media/${home.split("/").pop()}`;
  if (existsSync(runMediaUser)) {
    mountPoints.push(runMediaUser);
  }

  return mountPoints;
}

/**
 * Get additional root-level directories to show as shortcuts on Linux
 * (for accessing external drives and mounted filesystems)
 */
function getAdditionalRoots(): string[] {
  const os = platform();
  if (os === "linux") {
    return getLinuxMountPoints();
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
    // Also allow navigation to common mount points (/media, /mnt, /run/media) on Linux
    const devRootParent = dirname(devRoot);
    const additionalRoots = getAdditionalRoots();
    const isAllowedPath =
      targetPath.startsWith(devRoot) ||
      targetPath === devRootParent ||
      additionalRoots.some((root) => targetPath.startsWith(root));

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
    // Only offer the parent navigation if it's within the allowed scope
    const parentAllowed = parentPath.startsWith(devRootParent) && parentPath !== targetPath;
    const entries: Array<{ name: string; path: string }> = [];

    // On Linux, show mount points as quick-access when browsing from home directory
    const showMountPoints = platform() === "linux" && (targetPath === homedir() || targetPath === devRoot);

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

      // Add mount points as quick-access entries on Linux
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
