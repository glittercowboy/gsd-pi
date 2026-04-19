/**
 * workflow-dispatch.ts — Shared dispatchers for workflow plugins.
 *
 * Called by both `/gsd start <template>` (existing markdown path) and
 * `/gsd workflow <name>` (new direct dispatch). Keeps the prompt-build
 * logic in one place so md template behavior stays consistent.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { readFileSync } from "node:fs";

import { loadPrompt } from "./prompt-loader.js";
import type { WorkflowPlugin } from "./workflow-plugins.js";

// ─── Oneshot dispatch ────────────────────────────────────────────────────

/**
 * Strip the `<template_meta>` block from markdown content so it's not
 * repeated in the prompt body.
 */
function stripTemplateMeta(content: string): string {
  return content.replace(/<template_meta>[\s\S]*?<\/template_meta>\s*/, "");
}

/**
 * For a oneshot YAML plugin, extract the single-step prompt.
 * For multi-step YAML defined as oneshot, concatenate step prompts.
 */
function extractYamlOneshotPrompt(yamlContent: string): string {
  // Simple: just include the raw YAML so the model can follow it.
  // This keeps the oneshot format flexible without re-parsing.
  return `\`\`\`yaml\n${yamlContent}\n\`\`\``;
}

/**
 * Dispatch a oneshot workflow: load the prompt, inject the body, send.
 * No STATE.json, no branch switch, no auto-loop.
 */
export function dispatchOneshot(
  plugin: WorkflowPlugin,
  pi: ExtensionAPI,
  userArgs: string,
): void {
  const raw = readFileSync(plugin.path, "utf-8");
  const body = plugin.format === "yaml"
    ? extractYamlOneshotPrompt(raw)
    : stripTemplateMeta(raw);

  const prompt = loadPrompt("workflow-oneshot", {
    name: plugin.name,
    displayName: plugin.meta.displayName,
    body,
    userArgs: userArgs || "(none)",
  });

  pi.sendMessage(
    { customType: "gsd-workflow-oneshot", content: prompt, display: false },
    { triggerTurn: true },
  );
}

// ─── Markdown-phase dispatch ─────────────────────────────────────────────

export interface MarkdownPhaseDispatchOptions {
  templateId: string;
  templateName: string;
  templateDescription: string;
  phases: string[];
  complexity: string;
  artifactDir: string;
  branch: string;
  description: string;
  issueRef: string;
  date: string;
  workflowContent: string;
}

/**
 * Build and dispatch the `workflow-start.md` prompt for a markdown-phase plugin.
 * Returns the prompt that was sent (useful for tests).
 */
export function dispatchMarkdownPhase(
  opts: MarkdownPhaseDispatchOptions,
  pi: ExtensionAPI,
): string {
  const prompt = loadPrompt("workflow-start", {
    templateId: opts.templateId,
    templateName: opts.templateName,
    templateDescription: opts.templateDescription,
    phases: opts.phases.join(" → "),
    complexity: opts.complexity,
    artifactDir: opts.artifactDir || "(none)",
    branch: opts.branch,
    description: opts.description || "(none provided)",
    issueRef: opts.issueRef || "(none)",
    date: opts.date,
    workflowContent: opts.workflowContent,
  });

  pi.sendMessage(
    { customType: "gsd-workflow-template", content: prompt, display: false },
    { triggerTurn: true },
  );

  return prompt;
}
