import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveBridgeRuntimeConfig, requireProjectCwd } from "../../../../src/web/bridge-service.ts"
import type { SteerData } from "../../../lib/remaining-command-types.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  try {
    const projectCwd = requireProjectCwd(request);
    const config = resolveBridgeRuntimeConfig(undefined, projectCwd)
    const overridesPath = join(config.projectCwd, ".gsd", "OVERRIDES.md")

    let overridesContent: string | null = null
    if (existsSync(overridesPath)) {
      overridesContent = readFileSync(overridesPath, "utf-8")
    }

    const payload: SteerData = { overridesContent }
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
