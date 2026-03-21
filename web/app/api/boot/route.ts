import { collectBootPayload, resolveProjectCwd } from "../../../../src/web/bridge-service.ts";
import { cancelShutdown } from "../../../lib/shutdown-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // A boot request proves the client is alive — cancel any pending shutdown
  // that was scheduled by pagehide during a page refresh.
  cancelShutdown();

  const projectCwd = resolveProjectCwd(request);

  // When no project is configured (no GSD_WEB_PROJECT_CWD env and no ?project param),
  // return a minimal "no project" payload so the frontend can show the project picker.
  if (!projectCwd) {
    return Response.json({
      project: null,
      workspace: null,
      auto: null,
      onboarding: { locked: false },
      onboardingNeeded: false,
      resumableSessions: [],
      bridge: null,
      projectDetection: null,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const bootPayload = await collectBootPayload(projectCwd);

    return Response.json(bootPayload, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
