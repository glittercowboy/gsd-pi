import test from "node:test";
import assert from "node:assert/strict";

import { handleCoreCommand } from "../commands/handlers/core.ts";

function makeCtx(customResult: unknown) {
  const notices: Array<{ message: string; type?: string }> = [];
  return {
    hasUI: true,
    ui: {
      custom: async () => customResult,
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
    notices,
  };
}

test("visualize only falls back when ctx.ui.custom() is unavailable", async () => {
  const successCtx = makeCtx(true);
  const success = await handleCoreCommand("visualize", successCtx as any);
  assert.equal(success, true);
  assert.equal(successCtx.notices.length, 0, "successful overlay close does not trigger fallback");

  const fallbackCtx = makeCtx(undefined);
  const fallback = await handleCoreCommand("visualize", fallbackCtx as any);
  assert.equal(fallback, true);
  assert.equal(fallbackCtx.notices.length, 1, "unavailable overlay triggers fallback warning");
  assert.match(fallbackCtx.notices[0]!.message, /interactive terminal/i);
});

test("show-config only falls back when ctx.ui.custom() is unavailable", async () => {
  const successCtx = makeCtx(true);
  const success = await handleCoreCommand("show-config", successCtx as any);
  assert.equal(success, true);
  assert.equal(successCtx.notices.length, 0, "successful overlay close does not trigger fallback");

  const fallbackCtx = makeCtx(undefined);
  const fallback = await handleCoreCommand("show-config", fallbackCtx as any);
  assert.equal(fallback, true);
  assert.equal(fallbackCtx.notices.length, 1, "unavailable overlay triggers text fallback");
  assert.match(fallbackCtx.notices[0]!.message, /GSD Configuration/);
});

test("model command resolves and persists exact provider-qualified selection", async () => {
  const selectedModel = { provider: "openai", id: "gpt-5.4" };
  let applied: typeof selectedModel | null = null;
  const ctx = {
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        selectedModel,
      ],
    },
    ui: {
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
  } as any;
  const notices: Array<{ message: string; type?: string }> = [];
  const pi = {
    setModel: async (model: typeof selectedModel) => {
      applied = model;
      return true;
    },
  } as any;

  const handled = await handleCoreCommand("model openai/gpt-5.4", ctx, pi);
  assert.equal(handled, true);
  assert.deepEqual(applied, selectedModel);
  assert.match(notices[0]!.message, /openai\/gpt-5\.4/);
});

test("interactive model picker chooses provider first, then model", async () => {
  const selectedModel = { provider: "openai", id: "gpt-5.4" };
  let applied: typeof selectedModel | null = null;
  const selects: Array<{ title: string; options: string[] }> = [];
  const notices: Array<{ message: string; type?: string }> = [];

  const ctx = {
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai", id: "gpt-5.3-mini" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ],
    },
    ui: {
      select: async (title: string, options: string[]) => {
        selects.push({ title, options });
        return selects.length === 1 ? "openai (2 models)" : "gpt-5.4";
      },
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
  } as any;

  const pi = {
    setModel: async (model: typeof selectedModel) => {
      applied = model;
      return true;
    },
  } as any;

  const handled = await handleCoreCommand("model", ctx, pi);
  assert.equal(handled, true);
  assert.deepEqual(selects, [
    {
      title: "Select session model: — choose provider:",
      options: ["anthropic (2 models)", "openai (2 models)", "(cancel)"],
    },
    {
      title: "Select session model: — openai:",
      options: ["gpt-5.3-mini", "gpt-5.4", "(cancel)"],
    },
  ]);
  assert.deepEqual(applied, selectedModel);
  assert.match(notices[0]!.message, /openai\/gpt-5\.4/);
});

test("ambiguous typed model selection chooses provider first, then model", async () => {
  const selectedModel = { provider: "github-copilot", id: "gpt-5" };
  let applied: typeof selectedModel | null = null;
  const selects: Array<{ title: string; options: string[] }> = [];
  const notices: Array<{ message: string; type?: string }> = [];

  const ctx = {
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "gpt-5" },
        { provider: "github-copilot", id: "gpt-5" },
        { provider: "openai", id: "gpt-5-mini" },
      ],
    },
    ui: {
      select: async (title: string, options: string[]) => {
        selects.push({ title, options });
        return selects.length === 1 ? "github-copilot (1 model)" : "gpt-5";
      },
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
  } as any;

  const pi = {
    setModel: async (model: typeof selectedModel) => {
      applied = model;
      return true;
    },
  } as any;

  const handled = await handleCoreCommand("model gpt", ctx, pi);
  assert.equal(handled, true);
  assert.deepEqual(selects, [
    {
      title: "Multiple models match \"gpt\" — choose provider:",
      options: ["github-copilot (1 model)", "openai (2 models)", "(cancel)"],
    },
    {
      title: "Multiple models match \"gpt\" — github-copilot:",
      options: ["gpt-5", "(cancel)"],
    },
  ]);
  assert.deepEqual(applied, selectedModel);
  assert.match(notices[0]!.message, /github-copilot\/gpt-5/);
});
