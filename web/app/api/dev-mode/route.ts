import { existsSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const hostKind = process.env.GSD_WEB_HOST_KIND ?? "unknown";
  const packageRoot = process.env.GSD_WEB_PACKAGE_ROOT ?? "";
  const isSourceDev = hostKind === "source-dev";

  // When running via `npm run gsd:web` from the monorepo, the host resolves
  // as packaged-standalone (because the build exists), but the source web/
  // directory is still present at the package root. A truly published package
  // won't have web/app/ next to dist/.
  const isMonorepoDev =
    !isSourceDev &&
    packageRoot.length > 0 &&
    existsSync(join(packageRoot, "web", "app"));

  return Response.json(
    { isDevMode: isSourceDev || isMonorepoDev },
    { headers: { "Cache-Control": "no-store" } },
  );
}
