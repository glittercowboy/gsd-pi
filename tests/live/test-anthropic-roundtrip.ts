/**
 * Live: verify an API key can talk to Anthropic and receive a well-formed
 * completion.  Does NOT assert on model response content — sampling drift
 * would flake.  Checks status, response shape, and token accounting.
 *
 * Model ID is env-driven (`GSD_LIVE_ANTHROPIC_MODEL`) so retirement doesn't
 * require a code change.
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log("SKIPPED: ANTHROPIC_API_KEY not set");
  process.exit(77); // POSIX skip convention
}

const model = process.env.GSD_LIVE_ANTHROPIC_MODEL || "claude-sonnet-4-5";

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model,
    max_tokens: 32,
    messages: [{ role: "user", content: "ping" }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`Anthropic API error ${response.status} (model=${model}): ${body}`);
  // Retirement of the configured model should be a loud failure, not a skip.
  process.exit(1);
}

const data = (await response.json()) as {
  id?: string;
  role?: string;
  type?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

// Contract checks — these flake only if the vendor breaks the API contract,
// not on sampling drift.
if (data.type !== "message") {
  console.error(`Unexpected response type: ${JSON.stringify(data).slice(0, 200)}`);
  process.exit(1);
}
if (data.role !== "assistant") {
  console.error(`Unexpected role: ${data.role}`);
  process.exit(1);
}
if (!Array.isArray(data.content) || data.content.length === 0) {
  console.error(`Empty or missing content array`);
  process.exit(1);
}
const hasText = data.content.some(
  (b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0,
);
if (!hasText) {
  console.error(`No non-empty text block in response content`);
  process.exit(1);
}
if (!data.usage || data.usage.output_tokens <= 0) {
  console.error(`Missing or zero output_tokens in usage`);
  process.exit(1);
}
