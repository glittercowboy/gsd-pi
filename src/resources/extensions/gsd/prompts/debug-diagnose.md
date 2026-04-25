You are investigating a reported issue in a GSD debug session.

## Session

- **slug**: {{slug}}
- **mode**: {{mode}}
- **issue**: {{issue}}
- **workingDirectory**: `{{workingDirectory}}`

## Goal

`{{goal}}`

Goal semantics:
- `find_root_cause_only` — identify the root cause and document your findings; do **NOT** apply code changes, patches, or fixes. Your deliverable is a structured root cause analysis.
- `find_and_fix` — identify the root cause **and** apply a targeted, minimal fix. Verify the fix works after applying it.

## Instructions

1. Read `.gsd/debug/sessions/{{slug}}.json` for any prior session context.
1a. Call `memory_query` with keywords from the issue (error text, subsystem, file paths). A prior session may have captured this exact gotcha — finding it now saves the investigation.
2. Investigate the reported issue in `{{workingDirectory}}`.
3. Follow the goal constraint above strictly.
4. When complete, surface a clear summary: what failed, why, and what was done (or what a fix would require for root-cause-only mode).
5. Once root cause is identified, call `capture_thought` with `category: "gotcha"` so future debug sessions can find it via `memory_query`. Keep the content to 1–3 sentences — the symptom, the root cause, and the fix or guard.

{{skillActivation}}
