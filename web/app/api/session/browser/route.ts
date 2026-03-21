import {
  collectSessionBrowserPayload,
  requireProjectCwd,
} from "../../../../../src/web/bridge-service.ts"
import {
  isSessionBrowserNameFilter,
  isSessionBrowserSortMode,
} from "../../../../lib/session-browser-contract.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function invalidQuery(message: string): Response {
  return Response.json({ error: message }, {
    status: 400,
    headers: {
      "Cache-Control": "no-store",
    },
  })
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const sortMode = searchParams.get("sortMode")
  const nameFilter = searchParams.get("nameFilter")

  if (sortMode !== null && !isSessionBrowserSortMode(sortMode)) {
    return invalidQuery(`Invalid sortMode: ${sortMode}`)
  }

  if (nameFilter !== null && !isSessionBrowserNameFilter(nameFilter)) {
    return invalidQuery(`Invalid nameFilter: ${nameFilter}`)
  }

  const projectCwd = requireProjectCwd(request)
  const payload = await collectSessionBrowserPayload({
    query: searchParams.get("query") ?? undefined,
    sortMode: sortMode ?? undefined,
    nameFilter: nameFilter ?? undefined,
  }, projectCwd)

  return Response.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}
