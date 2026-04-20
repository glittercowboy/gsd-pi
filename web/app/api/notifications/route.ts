import { collectNotificationsData, clearNotificationsData } from "../../../../src/web/notifications-service.ts"
import { requireProjectCwd } from "../../../../src/web/bridge-service.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  try {
    const projectCwd = requireProjectCwd(request);
    const url = new URL(request.url)
    const countOnly = url.searchParams.get("countOnly") === "true"

    const payload = await collectNotificationsData(projectCwd)

    if (countOnly) {
      return Response.json(
        { unreadCount: payload.unreadCount },
        { headers: { "Cache-Control": "no-store" } },
      )
    }

    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const projectCwd = requireProjectCwd(request);
    await clearNotificationsData(projectCwd)
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
