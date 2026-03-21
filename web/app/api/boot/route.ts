import { collectBootPayload, resolveProjectCwd } from "../../../../src/web/bridge-service.ts";
import { cancelShutdown } from "../../../lib/shutdown-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // A boot request proves the client is alive — cancel any pending shutdown
  // that was scheduled by pagehide during a page refresh.
  cancelShutdown();

  const projectCwd = resolveProjectCwd(request);
  const bootPayload = await collectBootPayload(projectCwd);

  return Response.json(bootPayload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
