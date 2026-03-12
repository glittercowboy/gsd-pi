/**
 * SC-3: WebSocket server binds to 127.0.0.1 (loopback only).
 *
 * RED state: This test will fail until Plan 01 adds `hostname: "127.0.0.1"` to Bun.serve().
 * Currently createWsServer binds to 0.0.0.0 (all interfaces) by default.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createWsServer } from "../src/server/ws-server";
import type { WsServer } from "../src/server/ws-server";
import type { PlanningState } from "../src/server/types";

function makeMinimalState(): PlanningState {
  return {
    roadmap: { phases: [] },
    state: {
      milestone: "v1.0",
      milestone_name: "test",
      status: "in_progress",
      stopped_at: "",
      last_updated: "",
      last_activity: "",
      branch: "",
      progress: { total_phases: 1, completed_phases: 0, total_plans: 1, completed_plans: 0, percent: 0 },
    },
    config: {
      model_profile: "balanced",
      commit_docs: false,
      search_gitignored: false,
      branching_strategy: "none",
      phase_branch_template: "",
      milestone_branch_template: "",
      workflow: { research: false, plan_check: false, verifier: false, nyquist_validation: false, _auto_chain_active: false },
      parallelization: false,
      brave_search: false,
      mode: "balanced",
      granularity: "fine",
    },
    phases: [],
    requirements: [],
  };
}

describe("SC-3: WebSocket server binds to 127.0.0.1", () => {
  let wsServer: WsServer | null = null;

  afterEach(() => {
    if (wsServer) {
      wsServer.stop();
      wsServer = null;
    }
  });

  it("createWsServer produces a server whose hostname is 127.0.0.1", () => {
    // This test will FAIL until Plan 01 adds hostname: "127.0.0.1" to Bun.serve() in ws-server.ts.
    // Currently the server binds to 0.0.0.0 (Bun default when hostname is omitted).

    wsServer = createWsServer({
      port: 14200,
      getFullState: makeMinimalState,
    });

    // Access the underlying Bun server's hostname via the WsServer handle.
    // WsServer does not currently expose hostname — Plan 01 must add this.
    // @ts-expect-error — hostname not yet exposed on WsServer interface (Plan 01)
    const hostname: string | undefined = wsServer.hostname;

    expect(hostname).toBe("127.0.0.1");
  });
});
