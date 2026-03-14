/**
 * classify-intent-api.ts — Intent classification for Builder mode (BUILDER-04, BUILDER-07)
 *
 * Server-side module that calls Claude Haiku to classify user messages into one of
 * four intent categories. Used by Builder mode to route messages appropriately.
 *
 * Key behaviors:
 * - Reads ~/.gsd/auth.json for credentials (skips classify for OAuth-only providers)
 * - 1500ms timeout — falls through to GENERAL_CODING if too slow
 * - Any error → GENERAL_CODING (fail open, never drop a message)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type IntentType = "GSD_COMMAND" | "PHASE_QUESTION" | "GENERAL_CODING" | "UI_PHASE_GATE";

export const INTENT_SYSTEM_PROMPT = `You are a routing classifier for a developer tool.
Given the user message and current GSD project state, classify the intent as exactly one of:
- GSD_COMMAND (user wants to run a gsd workflow command like start, discuss, review, plan, execute)
- PHASE_QUESTION (user has a question about the current plan, decisions, or project state)
- GENERAL_CODING (user wants to write or modify code directly)
- UI_PHASE_GATE (user wants to build a visual frontend — CSS, component, page, layout, design — but no design context exists in the project state)

Respond with JSON only: { "intent": "<one of the four values>" }`;

const VALID_INTENTS = new Set<string>(["GSD_COMMAND", "PHASE_QUESTION", "GENERAL_CODING", "UI_PHASE_GATE"]);

/** Module-level auth override for testing. Set to null to use real auth.json. */
let authOverride: AuthData | null = null;

interface AuthData {
  provider?: string;
  access_token?: string;
  api_key?: string;
}

/** Set auth override for test isolation. Pass null to reset. */
export function _setAuthOverride(data: AuthData | null): void {
  authOverride = data;
}

async function readAuthData(): Promise<AuthData> {
  if (authOverride !== null) {
    return authOverride;
  }
  try {
    const authPath = join(homedir(), ".gsd", "auth.json");
    const content = await readFile(authPath, "utf-8");
    return JSON.parse(content) as AuthData;
  } catch {
    return {};
  }
}

/**
 * Classify the intent of a user message.
 *
 * @param message - The user's message text
 * @param stateContent - The current GSD project state (JSON string, used as context)
 * @param fetchFn - Optional fetch function override (inject mock in tests)
 * @returns The classified intent, or 'GENERAL_CODING' on any failure
 */
export async function classifyIntent(
  message: string,
  stateContent: string,
  fetchFn: typeof fetch = fetch,
): Promise<IntentType> {
  try {
    const auth = await readAuthData();
    const { provider } = auth;

    // OAuth-only providers cannot call api.anthropic.com with an API key
    if (provider === "anthropic" || provider === "github-copilot") {
      return "GENERAL_CODING";
    }

    // Get API key: openrouter uses api_key; api-key provider also uses api_key
    const apiKey = auth.api_key;
    if (!apiKey) {
      return "GENERAL_CODING";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);

    let res: Response;
    try {
      res = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 64,
          system: INTENT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `State:\n${stateContent.slice(0, 2000)}\n\nUser message: ${message}`,
            },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return "GENERAL_CODING";
    }

    const data = await res.json().catch(() => null);
    const text = data?.content?.[0]?.text;
    if (!text) {
      return "GENERAL_CODING";
    }

    let parsed: { intent?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return "GENERAL_CODING";
    }

    const intent = parsed?.intent;
    if (!intent || !VALID_INTENTS.has(intent)) {
      return "GENERAL_CODING";
    }

    return intent as IntentType;
  } catch {
    return "GENERAL_CODING";
  }
}

/**
 * POST /api/classify-intent handler.
 *
 * Body: { message: string, stateContext: string }
 * Response: { intent: IntentType }
 * Always returns 200 (fail open — a dropped message would be worse than wrong routing).
 */
export async function handleClassifyIntentRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  try {
    const body = (await req.json()) as { message?: unknown; stateContext?: unknown };

    if (typeof body.message !== "string") {
      return Response.json({ error: "message must be a string" }, { status: 400 });
    }

    const intent = await classifyIntent(body.message, typeof body.stateContext === "string" ? body.stateContext : "");
    return Response.json({ intent });
  } catch {
    return Response.json({ intent: "GENERAL_CODING" }, { status: 200 });
  }
}
