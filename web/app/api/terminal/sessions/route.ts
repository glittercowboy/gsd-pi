/**
 * Terminal session management.
 *
 * GET  /api/terminal/sessions        — list all sessions
 * POST /api/terminal/sessions        — create a new session (returns its id)
 * DELETE /api/terminal/sessions?id=x — destroy a session
 */

import {
  listSessions,
  getOrCreateSession,
  destroySession,
  isAllowedTerminalCommand,
} from "../../../../lib/pty-manager";
import { requireProjectCwd } from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist counter across HMR re-evaluations in dev
const g = globalThis as Record<string, unknown>;
if (!g.__gsd_pty_next_index__) g.__gsd_pty_next_index__ = 1;
function getNextIndex(): number {
  return (g.__gsd_pty_next_index__ as number)++;
}

export async function GET(): Promise<Response> {
  return Response.json({ sessions: listSessions() });
}

export async function POST(request: Request): Promise<Response> {
  const projectCwd = requireProjectCwd(request);
  const id = `term-${getNextIndex()}`;
  let command: string | undefined;
  try {
    const body = await request.json() as { command?: string };
    command = body.command;
  } catch {
    // No body or invalid JSON — use default shell
  }

  if (command && !isAllowedTerminalCommand(command)) {
    return Response.json(
      { error: `Command not allowed: ${command}` },
      { status: 403 },
    );
  }

  getOrCreateSession(id, projectCwd, command);
  return Response.json({ id });
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }
  const ok = destroySession(id);
  return Response.json({ ok, id });
}
