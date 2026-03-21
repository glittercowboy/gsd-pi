import {
  renameSessionInCurrentProject,
  requireProjectCwd,
} from "../../../../../src/web/bridge-service.ts"
import {
  SESSION_BROWSER_SCOPE,
  isSessionManageAction,
  type RenameSessionRequest,
  type SessionManageResponse,
} from "../../../../lib/session-browser-contract.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function invalidRequest(error: string): SessionManageResponse {
  return {
    success: false,
    action: "rename",
    scope: SESSION_BROWSER_SCOPE,
    code: "invalid_request",
    error,
  }
}

function responseStatus(response: SessionManageResponse): number {
  if (response.success) return 200

  switch (response.code) {
    case "invalid_request":
      return 400
    case "not_found":
      return 404
    case "onboarding_locked":
      return 423
    default:
      return 502
  }
}

function isRenameSessionRequest(value: unknown): value is RenameSessionRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    isSessionManageAction((value as { action?: string }).action) &&
    typeof (value as { sessionPath?: unknown }).sessionPath === "string" &&
    typeof (value as { name?: unknown }).name === "string"
  )
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch (error) {
    const response = invalidRequest(error instanceof Error ? error.message : String(error))
    return Response.json(response, {
      status: responseStatus(response),
      headers: {
        "Cache-Control": "no-store",
      },
    })
  }

  if (!isRenameSessionRequest(payload)) {
    const response = invalidRequest("Request body must be a rename action with sessionPath and name")
    return Response.json(response, {
      status: responseStatus(response),
      headers: {
        "Cache-Control": "no-store",
      },
    })
  }

  const projectCwd = requireProjectCwd(request)
  const response = await renameSessionInCurrentProject(payload, projectCwd)
  return Response.json(response, {
    status: responseStatus(response),
    headers: {
      "Cache-Control": "no-store",
    },
  })
}
