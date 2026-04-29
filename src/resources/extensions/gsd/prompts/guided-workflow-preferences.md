**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory. For `.gsd` files in this prompt, use absolute paths rooted at `{{workingDirectory}}` instead of discovering them with `Glob`.

Configure project workflow preferences. This stage runs ONCE per project, early in deep-mode bootstrap, before `discuss-project`. It applies a small set of recommended workflow defaults and persists them to the YAML frontmatter of `.gsd/PREFERENCES.md` (the same file the runtime reads its preferences from).

This is a **default-writing** stage — do NOT ask the user questions. Write the recommended defaults, then end. No follow-ups, no research, no opinion.

---

## Stage Banner

Print this banner verbatim in chat as your first action:

• WORKFLOW PREFERENCES

Then say: "Quick setup — applying recommended workflow defaults."

---

## Default Set

Use these recommended defaults without asking:

- `commit_policy: per-task` — atomic commit after every task; finest granularity, easiest to revert
- `branch_model: single` — all work on current branch
- `uat_dispatch: true` — verification runs automatically; failures pause execution
- `models.executor_class: balanced` — sensible cost/quality default
- `research: skip` — skip project research by default; users can explicitly opt into research later

---

## Output

Apply the defaults:

1. Read `{{workingDirectory}}/.gsd/PREFERENCES.md` if it exists. The file is YAML frontmatter (between `---` lines) followed by an optional markdown body. Parse the existing frontmatter so you can preserve unrelated keys (e.g. `planning_depth`).
2. Merge the defaults into the frontmatter under these keys, preserving any existing explicit value:
   - top-level `commit_policy: per-task`
   - top-level `branch_model: single`
   - top-level `uat_dispatch: true`
   - nested `models.executor_class: balanced`
3. Also set top-level `workflow_prefs_captured: true` — this is the single explicit marker the dispatch layer uses to know the wizard has run.
4. Write `{{workingDirectory}}/.gsd/PREFERENCES.md` back with the merged frontmatter and the original body preserved unchanged. Frontmatter delimiters are exactly `---` on their own lines.
5. Pre-seed the research decision so the standalone `research-decision` stage is a no-op if the user already answered here:
   - Ensure `{{workingDirectory}}/.gsd/runtime/` exists.
   - Write `{{workingDirectory}}/.gsd/runtime/research-decision.json`:
     ```json
     {
       "decision": "skip",
       "decided_at": "<ISO 8601 timestamp>",
       "source": "workflow-preferences",
       "reason": "deterministic-default"
     }
     ```
   Use `"skip"` unless an existing valid `{{workingDirectory}}/.gsd/runtime/research-decision.json` explicitly says `"research"` with `"source": "research-decision"` or `"source": "user"`.
6. Print a concise summary in chat: each key on its own line, format `key: value`. Include `commit_policy`, `branch_model`, `uat_dispatch`, `models.executor_class`, and `research` (`research: skip` unless preserving an explicit user research decision).
7. Say exactly: `"Workflow preferences saved."` — nothing else.

Do NOT write to `.gsd/config.json`; runtime preferences load from `PREFERENCES.md`.

---

## Critical rules

- Do NOT ask any questions. Defaults only, write file, done.
- Do NOT call `ask_user_questions`, `AskUserQuestion`, or any other interactive user-input tool in this stage.
- Do NOT change any keys other than the frontmatter keys specified plus `workflow_prefs_captured`. Research is persisted to `.gsd/runtime/research-decision.json`, NOT to `phases.skip_research`.
- Preserve existing explicit values for `commit_policy`, `branch_model`, `uat_dispatch`, and `models.executor_class`; only fill missing values with defaults.
