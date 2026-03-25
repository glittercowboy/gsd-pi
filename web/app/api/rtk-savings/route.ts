import { collectSelectiveLiveStatePayload, requireProjectCwd } from "../../../../src/web/bridge-service.ts";
import { getRtkSessionSavings } from "../../../../src/resources/extensions/shared/rtk-session-stats.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const projectCwd = requireProjectCwd(request);
  const payload = await collectSelectiveLiveStatePayload([], projectCwd);
  const sessionId = payload.bridge.sessionState?.sessionId ?? payload.bridge.activeSessionId ?? null;
  const savings = getRtkSessionSavings(projectCwd, sessionId);

  return Response.json(
    { savings },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
