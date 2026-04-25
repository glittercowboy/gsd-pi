import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatMcpInitResult,
  formatMcpStatusReport,
  formatMcpServerDetail,
  type McpServerStatus,
} from "../commands-mcp-status.ts";

// ─── formatMcpStatusReport ──────────────────────────────────────────────────

describe("formatMcpStatusReport", () => {
  test("returns no-servers message when list is empty", () => {
    const result = formatMcpStatusReport([]);
    assert.match(result, /no mcp servers configured/i);
  });

  test("lists all servers with connection status", () => {
    const servers: McpServerStatus[] = [
      { name: "railway", transport: "stdio", connected: true, toolCount: 5, error: undefined },
      { name: "linear", transport: "http", connected: false, toolCount: 0, error: undefined },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /railway/);
    assert.match(result, /linear/);
    assert.match(result, /connected/i);
    assert.match(result, /disconnected/i);
    assert.match(result, /5 tools/);
  });

  test("shows error state for servers with errors", () => {
    const servers: McpServerStatus[] = [
      { name: "broken", transport: "stdio", connected: false, toolCount: 0, error: "Connection refused" },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /error/i);
    assert.match(result, /Connection refused/);
  });

  test("includes server count in header", () => {
    const servers: McpServerStatus[] = [
      { name: "a", transport: "stdio", connected: true, toolCount: 3, error: undefined },
      { name: "b", transport: "http", connected: true, toolCount: 2, error: undefined },
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /2/);
  });
});

// ─── formatMcpServerDetail ──────────────────────────────────────────────────

describe("formatMcpServerDetail", () => {
  test("shows server name and transport", () => {
    const result = formatMcpServerDetail({
      name: "railway",
      transport: "stdio",
      connected: true,
      toolCount: 3,
      tools: ["railway_list_projects", "railway_deploy", "railway_logs"],
      error: undefined,
    });
    assert.match(result, /railway/);
    assert.match(result, /stdio/);
  });

  test("lists individual tools when available", () => {
    const result = formatMcpServerDetail({
      name: "railway",
      transport: "stdio",
      connected: true,
      toolCount: 2,
      tools: ["railway_list_projects", "railway_deploy"],
      error: undefined,
    });
    assert.match(result, /railway_list_projects/);
    assert.match(result, /railway_deploy/);
  });

  test("shows error message for failed servers", () => {
    const result = formatMcpServerDetail({
      name: "broken",
      transport: "stdio",
      connected: false,
      toolCount: 0,
      tools: [],
      error: "spawn ENOENT",
    });
    assert.match(result, /error/i);
    assert.match(result, /spawn ENOENT/);
  });

  test("shows disconnected status with no tools", () => {
    const result = formatMcpServerDetail({
      name: "offline",
      transport: "http",
      connected: false,
      toolCount: 0,
      tools: [],
      error: undefined,
    });
    assert.match(result, /disconnected/i);
  });
});

describe("formatMcpInitResult", () => {
  test("shows created message with config path", () => {
    const result = formatMcpInitResult("created", "/tmp/project/.mcp.json", "/tmp/project");
    assert.match(result, /created project mcp config/i);
    assert.match(result, /\/tmp\/project\/\.mcp\.json/);
    assert.match(result, /claude code/i);
  });

  test("shows unchanged message when config is current", () => {
    const result = formatMcpInitResult("unchanged", "/tmp/project/.mcp.json", "/tmp/project");
    assert.match(result, /already up to date/i);
  });
});
