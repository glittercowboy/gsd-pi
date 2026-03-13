/**
 * Tests for multi-session WebSocket routing and session action dispatch.
 */
import { describe, test, expect, beforeEach } from "bun:test";

// We test the WS message parsing and session action routing logic
// by creating a real WS server and connecting to it.

import { createWsServer } from "../src/server/ws-server";
import type { WsServer } from "../src/server/ws-server";
import type { PlanningState } from "../src/server/types";
import type { ServerWebSocket } from "bun";

// -- Helpers --

function makePlanningState(): PlanningState {
  return {
    roadmap: { phases: [] },
    state: {
      milestone: "v1.0",
      milestone_name: "milestone",
      status: "in_progress",
      stopped_at: "",
      last_updated: "",
      last_activity: "",
      progress: {
        total_phases: 10,
        completed_phases: 1,
        total_plans: 5,
        completed_plans: 3,
        percent: 60,
      },
    },
    config: {
      model_profile: "balanced",
      commit_docs: false,
      search_gitignored: false,
      branching_strategy: "none",
      phase_branch_template: "",
      milestone_branch_template: "",
      workflow: {
        research: true,
        plan_check: true,
        verifier: true,
        nyquist_validation: true,
        _auto_chain_active: false,
      },
      parallelization: false,
      brave_search: false,
      mode: "balanced",
      granularity: "fine",
    },
    phases: [],
    requirements: [],
  } as PlanningState;
}

let testPort = 19200;
function nextPort() {
  return testPort++;
}

describe("Session WebSocket Routing", () => {
  let wsServer: WsServer;
  let chatCalls: Array<{ prompt: string; sessionId?: string }>;
  let sessionActionCalls: Array<{ type: string; [key: string]: unknown }>;
  let port: number;

  beforeEach(() => {
    chatCalls = [];
    sessionActionCalls = [];
    port = nextPort();
  });

  function createServer() {
    wsServer = createWsServer({
      port,
      getFullState: makePlanningState,
      onChatMessage: (prompt: string, _ws: ServerWebSocket, sessionId?: string) => {
        chatCalls.push({ prompt, sessionId });
      },
      onSessionAction: (action, _ws) => {
        sessionActionCalls.push(action);
      },
    });
    return wsServer;
  }

  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    // Wait for initial full state message
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });
    return ws;
  }

  test("chat message with sessionId passes sessionId to handler", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "chat", prompt: "hello", sessionId: "sess-123" }));
      // Wait for server to process
      await new Promise((r) => setTimeout(r, 100));
      expect(chatCalls.length).toBe(1);
      expect(chatCalls[0].prompt).toBe("hello");
      expect(chatCalls[0].sessionId).toBe("sess-123");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("chat message without sessionId passes undefined sessionId (backward compat)", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "chat", prompt: "hello" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(chatCalls.length).toBe(1);
      expect(chatCalls[0].sessionId).toBeUndefined();
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("session_create action dispatches to onSessionAction", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "session_create" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(sessionActionCalls.length).toBe(1);
      expect(sessionActionCalls[0].type).toBe("session_create");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("session_close action dispatches with sessionId", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "session_close", sessionId: "sess-abc" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(sessionActionCalls.length).toBe(1);
      expect(sessionActionCalls[0].type).toBe("session_close");
      expect(sessionActionCalls[0].sessionId).toBe("sess-abc");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("session_rename action dispatches with sessionId and name", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "session_rename", sessionId: "sess-abc", name: "Debug" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(sessionActionCalls.length).toBe(1);
      expect(sessionActionCalls[0].type).toBe("session_rename");
      expect(sessionActionCalls[0].sessionId).toBe("sess-abc");
      expect(sessionActionCalls[0].name).toBe("Debug");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("session_list action dispatches", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "session_list" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(sessionActionCalls.length).toBe(1);
      expect(sessionActionCalls[0].type).toBe("session_list");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("session_interrupt action dispatches to onSessionAction", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      ws.send(JSON.stringify({ type: "session_interrupt", sessionId: "sess-xyz" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(sessionActionCalls.length).toBe(1);
      expect(sessionActionCalls[0].type).toBe("session_interrupt");
      expect(sessionActionCalls[0].sessionId).toBe("sess-xyz");
      ws.close();
    } finally {
      srv.stop();
    }
  });

  test("session_interrupt without handler does not throw", async () => {
    // Create server WITHOUT onSessionAction option
    const noActionPort = nextPort();
    const noActionServer = createWsServer({
      port: noActionPort,
      getFullState: makePlanningState,
      onChatMessage: () => {},
    });
    try {
      const ws = new WebSocket(`ws://localhost:${noActionPort}`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
      });
      // Wait for initial full state
      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });
      ws.send(JSON.stringify({ type: "session_interrupt", sessionId: "sess-xyz" }));
      await new Promise((r) => setTimeout(r, 100));
      // No assertion — test passes if no exception is thrown
      ws.close();
    } finally {
      noActionServer.stop();
    }
  });

  test("publishSessionUpdate broadcasts to chat topic", async () => {
    const srv = createServer();
    try {
      const ws = await connect();
      const messages: unknown[] = [];
      ws.onmessage = (e) => {
        messages.push(JSON.parse(e.data as string));
      };
      srv.publishSessionUpdate({ type: "session_update", sessions: [] });
      await new Promise((r) => setTimeout(r, 100));
      const sessionMsg = messages.find((m: any) => m.type === "session_update");
      expect(sessionMsg).toBeTruthy();
      ws.close();
    } finally {
      srv.stop();
    }
  });
});
