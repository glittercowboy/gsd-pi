import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  type EnsureProjectWorkflowMcpConfigResult,
  ensureProjectWorkflowMcpConfig,
} from "./mcp-project-config.js";
import { usesWorkflowMcpTransport, inferAuthModeFromBaseUrl } from "./workflow-mcp.js";

interface WorkflowMcpAutoPrepContext {
  model?: { provider?: string; baseUrl?: string };
  // modelRegistry is typed as object so any ModelRegistry instance
  // (which had getProviderAuthMode/isProviderRequestReady removed in pi 0.67.2)
  // can be passed without a structural mismatch. Runtime calls use dynamic
  // property access with typeof guards so missing methods are handled gracefully.
  modelRegistry?: object;
  ui?: Pick<ExtensionContext["ui"], "notify">;
}

/**
 * Check if any registered model belongs to the given provider and uses a
 * local:// baseUrl (which indicates an externalCli transport like claude-code).
 * pi 0.67.2 removed getProviderAuthMode; we infer the same from model data.
 */
function providerUsesLocalUrl(
  ctx: WorkflowMcpAutoPrepContext,
  provider: string,
): boolean {
  const reg = ctx.modelRegistry as Record<string, unknown> | undefined;
  const getAll = reg?.["getAll"];
  if (typeof getAll !== "function") return false;
  try {
    const models = (getAll as () => Array<{ provider?: string; baseUrl?: string }>)();
    return models.some(
      m => m.provider?.toLowerCase() === provider.toLowerCase()
        && typeof m.baseUrl === "string"
        && m.baseUrl.startsWith("local://"),
    );
  } catch {
    return false;
  }
}

function hasClaudeCodeProvider(ctx: WorkflowMcpAutoPrepContext): boolean {
  return providerUsesLocalUrl(ctx, "claude-code");
}

function isClaudeCodeProviderReady(ctx: WorkflowMcpAutoPrepContext): boolean {
  // isProviderRequestReady removed in pi 0.67.2.
  // If claude-code has any model available via getAvailable(), treat it as ready.
  const reg = ctx.modelRegistry as Record<string, unknown> | undefined;
  const getAvailable = reg?.["getAvailable"];
  if (typeof getAvailable !== "function") return false;
  try {
    const models = (getAvailable as () => Array<{ provider?: string }>)();
    return models.some(m => m.provider?.toLowerCase() === "claude-code");
  } catch {
    return false;
  }
}

export function shouldAutoPrepareWorkflowMcp(ctx: WorkflowMcpAutoPrepContext): boolean {
  const baseUrl = ctx.model?.baseUrl;
  const provider = ctx.model?.provider;
  const authMode = inferAuthModeFromBaseUrl(baseUrl);

  if (usesWorkflowMcpTransport(authMode, baseUrl)) return true;
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
