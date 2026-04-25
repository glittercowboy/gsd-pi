/**
 * Live: verify an API key can talk to OpenAI and receive a well-formed
 * chat completion.  Asserts on HTTP status + response shape, never on
 * sampled content.
 *
 * Model ID is env-driven (`GSD_LIVE_OPENAI_MODEL`) so retirement doesn't
 * require a code change.  Uses `max_completion_tokens` per the current
 * Chat Completions spec (the legacy `max_tokens` is deprecated).
 */
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log("SKIPPED: OPENAI_API_KEY not set");
  process.exit(77); // POSIX skip convention
}

const model = process.env.GSD_LIVE_OPENAI_MODEL || "gpt-4o-mini";

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    max_completion_tokens: 32,
    messages: [{ role: "user", content: "ping" }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`OpenAI API error ${response.status} (model=${model}): ${body}`);
  process.exit(1);
}

const data = (await response.json()) as {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

if (data.object !== "chat.completion") {
  console.error(`Unexpected response object: ${data.object}`);
  process.exit(1);
}
const choice = data.choices?.[0];
if (!choice || choice.message?.role !== "assistant") {
  console.error(`Missing or malformed first choice`);
  process.exit(1);
}
if (typeof choice.message?.content !== "string" || choice.message.content.length === 0) {
  console.error(`Empty or missing message.content`);
  process.exit(1);
}
if (!data.usage || data.usage.completion_tokens <= 0) {
  console.error(`Missing or zero completion_tokens in usage`);
  process.exit(1);
}
