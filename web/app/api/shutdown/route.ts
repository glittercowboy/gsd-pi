import { scheduleShutdown } from "../../../lib/shutdown-gate";
import { verifyAuthToken } from "../../../lib/auth-guard";

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  // Defense-in-depth: verify auth token even though middleware should catch it.
  const authError = verifyAuthToken(request);
  if (authError) return authError;

  // Schedule a deferred shutdown instead of exiting immediately.
  // This gives the client a window to cancel the exit on page refresh —
  // the boot route calls cancelShutdown() when it receives the next request.
  scheduleShutdown();

  return Response.json({ ok: true })
}
