---
name: create-mcp-server
description: Build, iterate, and evaluate Model Context Protocol (MCP) servers that expose external services as tools an LLM can call. Use when asked to "build an MCP server", "create an MCP tool", "wrap this API as MCP", "expose X to Claude", or when extending GSD with custom tool integrations. Covers research, schema/tool design, error handling, pagination, testing via MCP Inspector, and producing a 10-question eval set that proves the server actually enables real work.
---

<objective>
Produce a high-quality MCP server that an LLM can actually use — not one that merely parses spec-compliant. Quality is measured by how well the server enables real-world task completion, which means the tool descriptions, error messages, and pagination behave under model reasoning, not just at the wire level.
</objective>

<context>
GSD-2 consumes MCP heavily — see `src/resources/extensions/mcp-client/`, `src/resources/extensions/gsd/mcp-project-config.ts`, `src/resources/extensions/gsd/workflow-mcp.ts`, and `/gsd mcp` commands. Users frequently want to extend GSD with project-specific MCP servers (internal APIs, data sources, domain tools). This skill fills the authoring gap between "MCP exists" and "I have a working server."

Invocation points:
- User describes a service or API they want an LLM to reach
- `/gsd mcp init` scaffolds config but there's a tool integration to build
- Replacing a hand-rolled extension with a standard MCP server
</context>

<core_principle>
**THE QUALITY METRIC IS TASK COMPLETION, NOT SCHEMA VALIDITY.** A server that lists 30 tools with cryptic names and empty descriptions passes the protocol but fails the point. The tool description is the only thing an LLM has to decide whether to call it — write it like documentation for a stranger under time pressure.

**DESIGN FOR THE MODEL, NOT THE API.** A raw REST endpoint is rarely the right tool. Group, filter, and pre-shape responses so the model gets what it needs to reason, not a 40KB JSON blob it has to summarize. Fewer, deeper tools beat many, shallow ones.
</core_principle>

<process>

## Step 1: Research and scope

1. **Study modern MCP design.** Read the latest MCP protocol docs (not training data — fetch them). Read 2–3 reference implementations to see current patterns.
2. **Pick a framework.** TypeScript is the default — the reference SDK is the most mature. Python is fine for data-heavy or ML adjacencies.
3. **Analyze the target API.** Map the external service's endpoints, auth, rate limits, pagination, error shapes. Identify what a human workflow on top of it actually looks like — that's the cut line for tool design.
4. **Produce a brief.** One page: what the server does, who calls it, the 5–10 tools you plan to expose, and the top 3 design trade-offs. Confirm with the user.

## Step 2: Set up the project

Skeleton:

```text
server/
  src/
    index.ts         # MCP entry point — stdio or sse transport
    client.ts        # API client with auth, retries, typed errors
    tools/           # one file per tool, or grouped by domain
    pagination.ts    # shared cursor handling
    errors.ts        # MCP-friendly error formatting
  package.json       # @modelcontextprotocol/sdk as dep
  tsconfig.json
  README.md          # how to run, env vars, rate-limit notes
  evals.xml          # 10 eval questions (Phase 4)
```

Core infrastructure goes first: API client with typed errors, pagination helpers, consistent retry/timeout behavior. Do not inline these per tool.

## Step 3: Implement tools

For each tool:

1. **Name:** verb-noun, lowercase, snake_case. `search_issues`, `get_customer`, `create_deployment`. Not `do_thing` or `api_v2_post`.
2. **Description (frontmatter):** 2–4 sentences. State what the tool does, when to use it, when NOT to use it, and any required fields or quirks. This is the model's entire interface to the tool — write it carefully.
3. **Input schema (JSON Schema):** required fields marked, every field has a description, enums enumerated, examples included for free-form strings.
4. **Output shape:** typed, minimal, decision-ready. If the raw API returns 40 fields and only 6 matter for follow-up calls, return 6.
5. **Error handling:** never return raw HTTP errors. Translate to human-readable messages: "Rate limit exceeded (retry in 30s)", "Authorization expired", "No record found for ID X". Include the action the caller should take next.
6. **Pagination:** expose cursors explicitly. Do not leak "page N of M" into the model — leak "more results available, pass `cursor: abc123` to continue."

## Step 4: Build and test with MCP Inspector

1. Run the server under MCP Inspector. Verify it registers, every tool lists with its description, inputs schema-validate, outputs shape correctly.
2. Call every tool at least once manually through the Inspector UI. Check error paths.
3. Fix any "looks fine in isolation, breaks under the Inspector's framing" issues.

## Step 5: Produce the eval set

Write 10 evaluation questions in `evals.xml` that exercise the server end-to-end. Each question should require 2+ tool calls and at least one decision the model has to make based on earlier output. Cover:

- Happy path (2–3 questions)
- Error recovery (2 questions — "the first call failed, what next?")
- Pagination (1 question)
- Decision under partial information (2–3 questions)
- Cross-tool composition (1–2 questions)

Format:

```xml
<evals>
  <eval id="1">
    <question>...user request...</question>
    <expected>...concrete observable answer or tool-call sequence...</expected>
  </eval>
</evals>
```

Run the evals. If the model can't complete them, the server — not the model — needs work. Iterate on descriptions, error messages, and tool granularity.

## Step 6: Wire into GSD

Write the project's `.mcp.json` entry using `/gsd mcp init` as a starting point. Document env vars and startup in README.md. If the server is globally useful, suggest the user file it as a durable skill via `spike-wrap-up` or publish it.

</process>

<anti_patterns>

- **One-to-one REST mapping.** If the API has 30 endpoints, you likely want 6 tools.
- **Empty or auto-generated descriptions.** "Calls the /users endpoint" tells the model nothing it can reason with.
- **Raw error passthrough.** `{"error": "500"}` is useless. Translate.
- **Page-based pagination leaked as "page 1 of 5".** Use opaque cursors.
- **Skipping the Inspector.** If you didn't run it under the Inspector, you didn't test it.
- **No evals.** Without evals you have no signal on whether real task completion works.

</anti_patterns>

<success_criteria>

- [ ] Every tool has a description that could guide a cold-start model correctly.
- [ ] Errors are translated to actionable, human-readable messages.
- [ ] Pagination uses opaque cursors; no leaked page numbers.
- [ ] `evals.xml` has 10 questions; the model completes ≥8 without handholding.
- [ ] MCP Inspector test passes cleanly.
- [ ] README documents env, startup, and rate-limit behavior.
- [ ] Server is reachable from GSD via `.mcp.json` entry.

</success_criteria>
