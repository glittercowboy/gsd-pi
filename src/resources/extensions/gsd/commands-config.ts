/**
 * GSD Config — Tool API key management.
 *
 * Contains: TOOL_KEYS, loadToolApiKeys, getConfigAuthStorage, handleConfig
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Tool API key configurations.
 * This is the source of truth for tool credentials - used by both the config wizard
 * and session startup to load keys from auth.json into environment variables.
 */
export const TOOL_KEYS = [
  { id: "tavily",   env: "TAVILY_API_KEY",   label: "Tavily Search",     hint: "tavily.com/app/api-keys" },
  { id: "brave",    env: "BRAVE_API_KEY",     label: "Brave Search",      hint: "brave.com/search/api" },
  { id: "context7", env: "CONTEXT7_API_KEY",  label: "Context7 Docs",     hint: "context7.com/dashboard" },
  { id: "jina",     env: "JINA_API_KEY",      label: "Jina Page Extract", hint: "jina.ai/api" },
  { id: "groq",     env: "GROQ_API_KEY",      label: "Groq Voice",        hint: "console.groq.com" },
] as const;

function getStoredToolKey(auth: AuthStorage, providerId: string): string | undefined {
  const creds = auth.getCredentialsForProvider(providerId);
  const cred = creds.find((c) => c.type === "api_key" && c.key);
  return cred?.type === "api_key" ? cred.key : undefined;
}

/**
 * Load tool API keys from auth.json into environment variables.
 * Called at session startup to ensure tools have access to their credentials.
 */
export function loadToolApiKeys(): void {
  try {
    const authPath = join(process.env.HOME ?? "", ".gsd", "agent", "auth.json");
    if (!existsSync(authPath)) return;

    const auth = AuthStorage.create(authPath);
    for (const tool of TOOL_KEYS) {
      const key = getStoredToolKey(auth, tool.id);
      if (key && !process.env[tool.env]) {
        process.env[tool.env] = key;
      }
    }
  } catch {
    // Failed to load tool keys — ignore, they can still be set via env vars
  }
}

export function getConfigAuthStorage(): AuthStorage {
  const authPath = join(process.env.HOME ?? "", ".gsd", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true });
  return AuthStorage.create(authPath);
}

let deprecationWarned = false;

export async function handleConfig(ctx: ExtensionCommandContext): Promise<void> {
  if (!deprecationWarned) {
    ctx.ui.notify(
      "/gsd config is deprecated and will be removed. Use /gsd keys (manages both LLM and tool API keys).",
      "warning",
    );
    deprecationWarned = true;
  }

  const auth = getConfigAuthStorage();

  // Show current status
  const statusLines = ["GSD Tool Configuration\n"];
  for (const tool of TOOL_KEYS) {
    const hasKey = !!process.env[tool.env] || !!getStoredToolKey(auth, tool.id);
    statusLines.push(`  ${hasKey ? "\u2713" : "\u2717"} ${tool.label}${hasKey ? "" : ` \u2014 get key at ${tool.hint}`}`);
  }
  ctx.ui.notify(statusLines.join("\n"), "info");

  // Ask which tools to configure
  const options = TOOL_KEYS.map(t => {
    const hasKey = !!process.env[t.env] || !!getStoredToolKey(auth, t.id);
    return `${t.label} ${hasKey ? "(configured \u2713)" : "(not set)"}`;
  });
  options.push("(done)");

  let changed = false;
  while (true) {
    const choice = await ctx.ui.select("Configure which tool? Press Escape when done.", options);
    if (!choice || typeof choice !== "string" || choice === "(done)") break;

    const toolIdx = TOOL_KEYS.findIndex(t => choice.startsWith(t.label));
    if (toolIdx === -1) break;

    const tool = TOOL_KEYS[toolIdx];
    const input = await ctx.ui.input(
      `API key for ${tool.label} (${tool.hint}):`,
      "paste your key here",
    );

    if (input !== null && input !== undefined) {
      const key = input.trim();
      if (key) {
        auth.set(tool.id, { type: "api_key", key });
        process.env[tool.env] = key;
        ctx.ui.notify(`${tool.label} key saved and activated.`, "info");
        // Update option label
        options[toolIdx] = `${tool.label} (configured \u2713)`;
        changed = true;
      }
    }
  }

  if (changed) {
    await ctx.waitForIdle();
    await ctx.reload();
    ctx.ui.notify("Configuration saved. Extensions reloaded with new keys.", "info");
  }
}
