import {
  collectSelectiveLiveStatePayload,
  requireProjectCwd,
} from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const projectCwd = requireProjectCwd(request);
  const payload = await collectSelectiveLiveStatePayload(["auto"], projectCwd);

  const sessionState = payload.bridge.sessionState;
  const body = {
    bridgePhase: payload.bridge.phase,
    isStreaming: sessionState?.isStreaming ?? false,
    isCompacting: sessionState?.isCompacting ?? false,
    retryInProgress: sessionState?.retryInProgress ?? false,
    sessionId: sessionState?.sessionId ?? null,
    autoActive: payload.auto?.active ?? false,
    autoPaused: payload.auto?.paused ?? false,
    currentUnit: payload.auto?.currentUnit ?? null,
    updatedAt: payload.bridge.updatedAt,
  };

  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
