// GSD-2 — Tool Compatibility Registry (ADR-005 Phase 2)
// Maps tool names to their provider compatibility metadata.
// Used by the model router to filter tools incompatible with the selected provider.

import type { ToolCompatibility } from "../extensions/types.js";

// ─── Registry State ─────────────────────────────────────────────────────────

const registry = new Map<string, ToolCompatibility>();

// ─── Built-in Tool Compatibility (universally compatible) ───────────────────
// Built-in tools (bash, read, write, edit, grep, find, ls) produce text-only
// results and use standard JSON Schema — compatible with all providers.

const BUILTIN_TOOLS: Record<string, ToolCompatibility> = {
  bash: {},
  read: {},
  write: {},
  edit: {},
  grep: {},
  find: {},
  ls: {},
  lsp: {},
  hashline_edit: {},
  hashline_read: {},
};

// Pre-populate registry with built-in tools
for (const [name, compat] of Object.entries(BUILTIN_TOOLS)) {
  registry.set(name, compat);
}

// ─── MCP Tool Defaults ─────────────────────────────────────────────────────
// MCP tools may use complex schemas. Default to cautious compatibility.

const MCP_TOOL_DEFAULTS: ToolCompatibility = {
  schemaFeatures: ["patternProperties"],
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Register compatibility metadata for a tool.
 * Called automatically by registerTool() for extension tools that include
 * compatibility metadata in their ToolDefinition.
 */
export function registerToolCompatibility(toolName: string, compatibility: ToolCompatibility): void {
  registry.set(toolName, compatibility);
}

/**
 * Get compatibility metadata for a tool.
 * Returns undefined for unknown tools (treated as universally compatible
 * per ADR-005 principle: "fail open, don't restrict without data").
 */
export function getToolCompatibility(toolName: string): ToolCompatibility | undefined {
  return registry.get(toolName);
}

/**
 * Get all registered tool compatibility entries.
 */
export function getAllToolCompatibility(): ReadonlyMap<string, ToolCompatibility> {
  return registry;
}

/**
 * Register an MCP tool with default cautious compatibility.
 * MCP tools may use complex schemas that some providers don't support.
 */
export function registerMcpToolCompatibility(toolName: string, overrides?: Partial<ToolCompatibility>): void {
  registry.set(toolName, { ...MCP_TOOL_DEFAULTS, ...overrides });
}

/**
 * Clear all non-builtin entries (for testing).
 */
export function resetToolCompatibilityRegistry(): void {
  registry.clear();
  for (const [name, compat] of Object.entries(BUILTIN_TOOLS)) {
    registry.set(name, compat);
  }
}
