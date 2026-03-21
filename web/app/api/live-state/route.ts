import {
  collectSelectiveLiveStatePayload,
  requireProjectCwd,
  type BridgeSelectiveLiveStateDomain,
} from "../../../../src/web/bridge-service.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_DOMAINS = new Set<BridgeSelectiveLiveStateDomain>(["auto", "workspace", "resumable_sessions"])

function invalidQuery(message: string): Response {
  return Response.json(
    { error: message },
    {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  )
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const requestedDomains = searchParams.getAll("domain")

  if (requestedDomains.some((domain) => !VALID_DOMAINS.has(domain as BridgeSelectiveLiveStateDomain))) {
    return invalidQuery(`Invalid live-state domain: ${requestedDomains.find((domain) => !VALID_DOMAINS.has(domain as BridgeSelectiveLiveStateDomain))}`)
  }

  const domains = (requestedDomains.length > 0 ? requestedDomains : ["auto", "workspace", "resumable_sessions"]) as BridgeSelectiveLiveStateDomain[]
  const projectCwd = requireProjectCwd(request)
  const payload = await collectSelectiveLiveStatePayload(domains, projectCwd)

  return Response.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}
