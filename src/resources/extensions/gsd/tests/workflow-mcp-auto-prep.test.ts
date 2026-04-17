import test from "node:test";
import assert from "node:assert/strict";

import { prepareWorkflowMcpForProject, shouldAutoPrepareWorkflowMcp } from "../workflow-mcp-auto-prep.ts";

// pi 0.67.2: getProviderAuthMode and isProviderRequestReady removed from ModelRegistry.
// shouldAutoPrepareWorkflowMcp now uses:
//   - inferAuthModeFromBaseUrl(model.baseUrl) to detect local:// transports
//   - getAll() to check if any registered model uses a local:// baseUrl
//   - getAvailable() to check if claude-code has available models

test("shouldAutoPrepareWorkflowMcp enables prep for local:// transport on current model", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp enables prep when claude-code provider is in getAll() with local baseUrl", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getAll: () => [
        { provider: "claude-code", baseUrl: "local://claude-code" },
        { provider: "openai", baseUrl: "https://api.openai.com" },
      ],
      getAvailable: () => [],
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp enables prep when claude-code provider is available via getAvailable()", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [
        { provider: "claude-code" },
      ],
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp stays disabled when neither transport nor provider match", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getAll: () => [
        { provider: "openai", baseUrl: "https://api.openai.com" },
      ],
      getAvailable: () => [
        { provider: "openai" },
      ],
    },
  });

  assert.equal(result, false);
});

test("prepareWorkflowMcpForProject warns with /gsd mcp init guidance when prep fails", () => {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const result = prepareWorkflowMcpForProject(
    {
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getAll: () => [{ provider: "claude-code", baseUrl: "local://claude-code" }],
        getAvailable: () => [{ provider: "claude-code" }],
      },
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error") => {
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
