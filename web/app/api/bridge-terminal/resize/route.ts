import { getProjectBridgeServiceForCwd, requireProjectCwd } from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { cols?: number; rows?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cols = body.cols;
  const rows = body.rows;
  if (typeof cols !== "number" || typeof rows !== "number" || cols < 1 || rows < 1) {
    return Response.json({ error: "cols and rows must be positive numbers" }, { status: 400 });
  }

  try {
    const projectCwd = requireProjectCwd(request);
    const bridge = getProjectBridgeServiceForCwd(projectCwd);
    await bridge.resizeTerminal(Math.floor(cols), Math.floor(rows));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
