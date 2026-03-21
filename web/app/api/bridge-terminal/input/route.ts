import { getProjectBridgeServiceForCwd, requireProjectCwd } from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { data?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.data !== "string") {
    return Response.json({ error: "data must be a string" }, { status: 400 });
  }

  try {
    const projectCwd = requireProjectCwd(request);
    const bridge = getProjectBridgeServiceForCwd(projectCwd);
    await bridge.sendTerminalInput(body.data);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
