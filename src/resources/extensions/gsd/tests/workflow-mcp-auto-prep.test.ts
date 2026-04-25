import test from "node:test";
import assert from "node:assert/strict";

import { prepareWorkflowMcpForProject, shouldAutoPrepareWorkflowMcp } from "../workflow-mcp-auto-prep.ts";

test("shouldAutoPrepareWorkflowMcp enables prep for externalCli local transport", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
    modelRegistry: {
      getProviderAuthMode: () => "externalCli",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp enables prep when claude-code provider is ready", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: (provider: string) => provider === "claude-code",
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp enables prep when claude-code provider is registered", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: (provider: string) => provider === "claude-code" ? "externalCli" : "apiKey",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp stays disabled when neither transport nor provider readiness match", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, false);
});

test("prepareWorkflowMcpForProject warns with /gsd mcp init guidance when prep fails", () => {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" | "success" }> = [];
  const result = prepareWorkflowMcpForProject(
    {
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getProviderAuthMode: () => "externalCli",
        isProviderRequestReady: () => true,
      },
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error" | "success") => {
          notifications.push({ message, level: level ?? "info" });
        },
      },
    },
    "/",
  );

  assert.equal(result, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /Please run \/gsd mcp init \./);
});
