import { collectDoctorData, applyDoctorFixes } from "../../../../src/web/doctor-service.ts"
import { requireProjectCwd } from "../../../../src/web/bridge-service.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const scope = url.searchParams.get("scope") ?? undefined
    const projectCwd = requireProjectCwd(request);
    const payload = await collectDoctorData(scope, projectCwd)
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    )
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    let scope: string | undefined
    try {
      const body = await request.json()
      scope = body?.scope ?? undefined
    } catch {
      // No body or invalid JSON — scope stays undefined
    }
    const projectCwd = requireProjectCwd(request);
    const payload = await applyDoctorFixes(scope, projectCwd)
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    )
  }
}
