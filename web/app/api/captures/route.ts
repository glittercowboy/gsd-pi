import { collectCapturesData, resolveCaptureAction } from "../../../../src/web/captures-service.ts"
import { requireProjectCwd } from "../../../../src/web/bridge-service.ts"
import type { CaptureResolveRequest } from "../../../lib/knowledge-captures-types.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_CLASSIFICATIONS = new Set([
  "quick-task",
  "inject",
  "defer",
  "replan",
  "note",
])

export async function GET(request: Request): Promise<Response> {
  try {
    const projectCwd = requireProjectCwd(request);
    const payload = await collectCapturesData(projectCwd)
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
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      )
    }

    const validation = validateResolveRequest(body)
    if (validation.error) {
      return Response.json(
        { error: validation.error },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      )
    }

    const projectCwd = requireProjectCwd(request);
    const result = await resolveCaptureAction(validation.value!, projectCwd)
    return Response.json(result, {
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

function validateResolveRequest(
  body: unknown,
): { value?: CaptureResolveRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" }
  }

  const obj = body as Record<string, unknown>

  if (typeof obj.captureId !== "string" || !obj.captureId.trim()) {
    return { error: "Missing or invalid field: captureId (string required)" }
  }

  if (typeof obj.classification !== "string" || !VALID_CLASSIFICATIONS.has(obj.classification)) {
    return {
      error: `Missing or invalid field: classification (must be one of: ${[...VALID_CLASSIFICATIONS].join(", ")})`,
    }
  }

  if (typeof obj.resolution !== "string" || !obj.resolution.trim()) {
    return { error: "Missing or invalid field: resolution (non-empty string required)" }
  }

  if (typeof obj.rationale !== "string" || !obj.rationale.trim()) {
    return { error: "Missing or invalid field: rationale (non-empty string required)" }
  }

  return {
    value: {
      captureId: obj.captureId.trim(),
      classification: obj.classification as CaptureResolveRequest["classification"],
      resolution: obj.resolution.trim(),
      rationale: obj.rationale.trim(),
    },
  }
}
