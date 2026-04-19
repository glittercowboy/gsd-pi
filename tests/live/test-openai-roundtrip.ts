const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log("SKIPPED: OPENAI_API_KEY not set");
  process.exit(1);
}

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: LIVE_TEST_OK" }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`OpenAI API error ${response.status}: ${body}`);
  process.exit(1);
}

const data = (await response.json()) as {
  choices: Array<{ message: { content: string } }>;
};
const text = data.choices?.[0]?.message?.content || "";

if (!text.includes("LIVE_TEST_OK")) {
  console.error(`Unexpected response: "${text}"`);
  process.exit(1);
}
