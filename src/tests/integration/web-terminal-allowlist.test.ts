import test from "node:test";
import assert from "node:assert/strict";

const sessionsRoute = await import("../../../web/app/api/terminal/sessions/route.ts");
const streamRoute = await import("../../../web/app/api/terminal/stream/route.ts");

test("terminal session creation rejects disallowed commands", async () => {
  const response = await sessionsRoute.POST(
    new Request("http://localhost/api/terminal/sessions?project=/tmp/demo", {
      method: "POST",
      body: JSON.stringify({ command: "rm" }),
    }),
  );

  assert.equal(response.status, 403);
  const payload = await response.json() as { error?: string };
  assert.match(payload.error ?? "", /Command not allowed/);
});

test("terminal stream rejects disallowed commands before creating a PTY session", async () => {
  const response = await streamRoute.GET(
    new Request("http://localhost/api/terminal/stream?id=term-1&project=/tmp/demo&command=rm"),
  );

  assert.equal(response.status, 403);
  const payload = await response.json() as { error?: string };
  assert.match(payload.error ?? "", /Command not allowed/);
});
