// gsd-2 / pi-ai: API-shape family predicates
//
// Rule (see docs/dev/ADR-012-provider-id-vs-api-shape.md):
//   Gate API-shape-dependent behavior (tool schemas, request payload shape,
//   streaming format) on `model.api`, never on `model.provider`.
//   `provider` is a credential/transport identifier that varies by vendor
//   routing (e.g. `anthropic`, `claude-code`, `anthropic-vertex`,
//   `amazon-bedrock`, `vercel-ai-gateway`) even when the wire protocol is
//   identical.

/** Minimal shape — any object with an optional `api` string works. */
type HasApi = { api?: string } | null | undefined;

/**
 * True for any transport that speaks the Anthropic Messages wire protocol:
 * direct Anthropic, Claude Code OAuth, Anthropic-on-Vertex, Vercel AI Gateway
 * Anthropic routes, etc.
 *
 * Excludes Bedrock-hosted Claude — Bedrock Converse uses a different tool
 * schema and is matched by `isBedrockApi` instead.
 */
export function isAnthropicApi(model: HasApi): boolean {
  const api = model?.api;
  return api === "anthropic-messages" || api === "anthropic-vertex";
}

/**
 * True for any transport that speaks an OpenAI-shaped wire protocol:
 * Chat Completions, Responses, Azure-hosted Responses, Codex-hosted Responses.
 */
export function isOpenAIApi(model: HasApi): boolean {
  const api = model?.api;
  return (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-codex-responses"
  );
}

/**
 * True for any transport that speaks a Google Gemini wire protocol:
 * Generative AI REST, Gemini CLI, Vertex AI.
 */
export function isGeminiApi(model: HasApi): boolean {
  const api = model?.api;
  return (
    api === "google-generative-ai" ||
    api === "google-gemini-cli" ||
    api === "google-vertex"
  );
}

/** True for AWS Bedrock Converse transports. */
export function isBedrockApi(model: HasApi): boolean {
  return model?.api === "bedrock-converse-stream";
}
