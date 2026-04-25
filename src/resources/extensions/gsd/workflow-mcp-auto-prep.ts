import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  type EnsureProjectWorkflowMcpConfigResult,
  ensureProjectWorkflowMcpConfig,
} from "./mcp-project-config.js";
import { usesWorkflowMcpTransport } from "./workflow-mcp.js";

interface WorkflowMcpAutoPrepContext {
  model?: { provider?: string; baseUrl?: string };
  modelRegistry?: {
    getProviderAuthMode?: (provider: string) => string;
    isProviderRequestReady?: (provider: string) => boolean;
  };
  ui?: Pick<ExtensionContext["ui"], "notify">;
}

function getAuthModeSafe(
  ctx: WorkflowMcpAutoPrepContext,
  provider: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  const getAuthMode = ctx.modelRegistry?.getProviderAuthMode;
  if (typeof getAuthMode !== "function") return undefined;
  try {
    return getAuthMode(provider);
  } catch {
    return undefined;
  }
}

function hasClaudeCodeProvider(ctx: WorkflowMcpAutoPrepContext): boolean {
  return getAuthModeSafe(ctx, "claude-code") === "externalCli";
}

function isClaudeCodeProviderReady(ctx: WorkflowMcpAutoPrepContext): boolean {
  const readyCheck = ctx.modelRegistry?.isProviderRequestReady;
  if (typeof readyCheck !== "function") return false;
  try {
    return readyCheck("claude-code");
  } catch {
    return false;
  }
}

export function shouldAutoPrepareWorkflowMcp(ctx: WorkflowMcpAutoPrepContext): boolean {
  const provider = ctx.model?.provider;
  const baseUrl = ctx.model?.baseUrl;
  const authMode = getAuthModeSafe(ctx, provider);

  if (usesWorkflowMcpTransport(authMode as any, baseUrl)) return true;
  if (provider === "claude-code") return true;
  if (hasClaudeCodeProvider(ctx)) return true;
  return isClaudeCodeProviderReady(ctx);
}

export function prepareWorkflowMcpForProject(
  ctx: WorkflowMcpAutoPrepContext,
  projectRoot: string,
): EnsureProjectWorkflowMcpConfigResult | null {
  if (!shouldAutoPrepareWorkflowMcp(ctx)) return null;

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    if (result.status !== "unchanged") {
      ctx.ui?.notify?.(`Claude Code MCP prepared at ${result.configPath}`, "info");
    }
    return result;
  } catch (err) {
    ctx.ui?.notify?.(
      `Claude Code MCP prep failed: ${err instanceof Error ? err.message : String(err)}. Detected Claude Code model but no workflow MCP. Please run /gsd mcp init . from your project root.`,
      "warning",
    );
    return null;
  }
}
