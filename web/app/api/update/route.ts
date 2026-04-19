import {
  checkForUpdate,
  getUpdateStatus,
  triggerUpdate,
} from "../../../../src/web/update-service.ts"
import { verifyAuthToken } from "../../../lib/auth-guard";

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  // Defense-in-depth: verify auth token even though middleware should catch it.
  const authError = verifyAuthToken(request);
  if (authError) return authError;
  try {
    const versionInfo = await checkForUpdate()
    const { status, error, targetVersion } = getUpdateStatus()

    return Response.json(
      {
        currentVersion: versionInfo.currentVersion,
        latestVersion: versionInfo.latestVersion,
        updateAvailable: versionInfo.updateAvailable,
        updateStatus: status,
        ...(error ? { error } : {}),
        ...(targetVersion ? { targetVersion } : {}),
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    )
  }
}

export async function POST(request: Request): Promise<Response> {
  // Defense-in-depth: verify auth token even though middleware should catch it.
  const authError = verifyAuthToken(request);
  if (authError) return authError;
  try {
    const versionInfo = await checkForUpdate()
    const started = triggerUpdate(versionInfo.latestVersion)

    if (!started) {
      return Response.json(
        { error: "Update already in progress" },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      )
    }

    return Response.json(
      { triggered: true },
      {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    )
  }
}
