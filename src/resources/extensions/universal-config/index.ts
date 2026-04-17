/**
 * Universal Config Discovery Extension
 *
 * Auto-detects and displays configuration from 8 AI coding tools:
 * Claude Code, Cursor, Windsurf, Gemini CLI, Codex, Cline,
 * GitHub Copilot, and VS Code.
 *
 * Discovers: MCP servers, rules/instructions, context files, and settings.
 *
 * Read-only: never modifies other tools' config files.
 *
 * Provides:
 *   - discover_configs tool (LLM-callable)
 *   - /configs command (slash command)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAllConfigs } from "./discovery.js";
import { formatDiscoveryForTool, formatDiscoveryForCommand } from "./format.js";
import type { DiscoveryResult, ToolId } from "./types.js";

// Cache discovery result within a session to avoid re-scanning
let cachedResult: DiscoveryResult | null = null;

export default function universalConfig(pi: ExtensionAPI) {
  // ── Tool: discover_configs ──────────────────────────────────────────────

  pi.registerTool({
    name: "discover_configs",
    label: "Discover Configs",
    description:
      "Scan for existing AI coding tool configurations in this project and the user's home directory. " +
      "Discovers MCP servers, rules, context files, settings, Claude skills, and Claude plugins from Claude Code, Cursor, Windsurf, " +
      "Gemini CLI, Codex, Cline, GitHub Copilot, and VS Code. Read-only — never modifies config files.",
    promptSnippet: "Discover existing AI tool configs (MCP servers, rules, context files, Claude skills/plugins) from 8 coding tools.",
    promptGuidelines: [
      "Use discover_configs when a user asks about their existing configuration, MCP servers, or when switching from another AI coding tool.",
      "The tool scans both user-level (~/) and project-level (./) config directories.",
      "Results include MCP servers that could be reused, rules/instructions that could be adapted, context files from other tools, and Claude skills/plugins that could be imported.",
    ],
    parameters: Type.Object({
      tool: Type.Optional(
        Type.String({
          description:
            "Filter to a specific tool: claude, cursor, windsurf, gemini, codex, cline, github-copilot, vscode. Omit to scan all.",
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description: "Force re-scan even if cached results exist. Default: false.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.refresh || !cachedResult) {
        cachedResult = await discoverAllConfigs(ctx.cwd);
      }

      let result = cachedResult;

      // Filter to specific tool if requested
      if (params.tool) {
        const toolId = params.tool as ToolId;
        const filtered = result.tools.filter((t) => t.tool.id === toolId);
        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: `No scanner found for tool "${params.tool}". Valid tools: claude, cursor, windsurf, gemini, codex, cline, github-copilot, vscode` }],
            isError: true,
            details: undefined as unknown,
          };
        }
        // Rebuild result with filtered tools
        const allItems = filtered.flatMap((t) => t.items);
        result = {
          ...result,
          tools: filtered,
          allItems,
          summary: {
            ...result.summary,
            mcpServers: allItems.filter((i) => i.type === "mcp-server").length,
            rules: allItems.filter((i) => i.type === "rule").length,
            contextFiles: allItems.filter((i) => i.type === "context-file").length,
            settings: allItems.filter((i) => i.type === "settings").length,
            claudeSkills: allItems.filter((i) => i.type === "claude-skill").length,
            claudePlugins: allItems.filter((i) => i.type === "claude-plugin").length,
            totalItems: allItems.length,
            toolsWithConfig: filtered.filter((t) => t.items.length > 0).length,
          },
        };
      }

      const text = formatDiscoveryForTool(result);
      return {
        content: [{ type: "text", text }],
        details: undefined as unknown,
      };
    },
  });

  // ── Command: /configs ───────────────────────────────────────────────────

  pi.registerCommand("configs", {
    description: "Show discovered AI tool configurations (MCP servers, rules, context files)",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      // Always refresh on command invocation
      cachedResult = await discoverAllConfigs(ctx.cwd);
      const lines = formatDiscoveryForCommand(cachedResult);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Invalidate cache on session switch ──────────────────────────────────

  pi.on("session_before_switch", () => {
    cachedResult = null;
  });
}
