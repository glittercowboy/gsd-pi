import {
  buildBridgeFailureResponse,
  requireProjectCwd,
  sendBridgeInput,
} from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isBridgeInput(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function responseStatus(response: { success: boolean; code?: string }): number {
  if (response.success) return 200;
  if (response.code === "onboarding_locked") return 423;
  return 502;
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    return Response.json(buildBridgeFailureResponse("parse", error), { status: 400 });
  }

  if (!isBridgeInput(payload)) {
    return Response.json(buildBridgeFailureResponse("parse", "Request body must be a JSON object with a type field"), {
      status: 400,
    });
  }

  try {
    const projectCwd = requireProjectCwd(request);
    const response = await sendBridgeInput(payload as Parameters<typeof sendBridgeInput>[0], projectCwd);
    if (response === null) {
      return Response.json({ ok: true }, { status: 202 });
    }

    return Response.json(response, {
      status: responseStatus(response),
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(buildBridgeFailureResponse(payload.type, error), { status: 503 });
  }
}
