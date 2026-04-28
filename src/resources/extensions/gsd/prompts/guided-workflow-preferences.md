**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

Configure project workflow preferences. This stage runs ONCE per project, early in deep-mode bootstrap, before `discuss-project`. It captures a small set of high-impact workflow toggles via structured questions and persists them to the YAML frontmatter of `.gsd/PREFERENCES.md` (the same file the runtime reads its preferences from).

This is a **fixed-question** stage — do NOT do open Socratic interviewing. Ask the questions below verbatim, capture answers, write the file, end. No follow-ups, no research, no opinion.

**Structured questions available: {{structuredQuestionsAvailable}}**

---

## Stage Banner

Print this banner verbatim in chat as your first action:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► WORKFLOW PREFERENCES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then say: "Quick setup — five workflow toggles. Defaults are sensible if you're not sure."

---

## Question Set

Ask all five questions in a single `ask_user_questions` call (one turn) when `{{structuredQuestionsAvailable}}` is `true`. When `false`, ask in plain text as a numbered list.

### Q1. Commit policy

- **header:** "Commits"
- **question:** "How often do you want commits during execution?"
- **options:**
  - "Per task (Recommended)" — atomic commit after every task; finest granularity, easiest to revert
  - "Per slice" — one commit per slice; cleaner history, harder to revert mid-slice
  - "Manual" — no auto-commits; you control everything

### Q2. Executor model class

- **header:** "Executor"
- **question:** "Which model class should run task execution?"
- **options:**
  - "Balanced (Recommended)" — sensible cost/quality default
  - "Quality" — best model available; higher cost
  - "Budget" — cheapest available; faster but lower quality

### Q3. Research before requirements

- **header:** "Research"
- **question:** "Run domain research before defining requirements?"
- **options:**
  - "Yes (Recommended)" — surfaces table-stakes capabilities, common pitfalls, ecosystem norms
  - "Skip" — go straight to requirements; you know this domain

### Q4. Auto UAT after slice

- **header:** "Auto UAT"
- **question:** "Run UAT automatically after each slice completes?"
- **options:**
  - "Yes (Recommended)" — verification runs automatically; failures pause execution
  - "No" — verification deferred; you run UAT manually

### Q5. Branch model

- **header:** "Branches"
- **question:** "How should work be isolated in git?"
- **options:**
  - "Single branch (Recommended for solo work)" — all work on current branch
  - "Per-milestone worktree" — each milestone gets its own worktree
  - "Per-slice worktree" — each slice gets its own worktree

---

## Output

Once all five answers are captured:

1. Read `.gsd/PREFERENCES.md` if it exists. The file is YAML frontmatter (between `---` lines) followed by an optional markdown body. Parse the existing frontmatter so you can preserve unrelated keys (e.g. `planning_depth`).
2. Merge the answers into the frontmatter under these keys:
   - Q1 commit policy → top-level `commit_policy: per-task | per-slice | manual`
   - Q2 executor model class → nested `models.executor_class: balanced | quality | budget`
   - Q3 research → nested `phases.skip_research: false | true` (skip=true if user picked "Skip")
   - Q4 auto UAT → top-level `uat_dispatch: true | false`
   - Q5 branch model → top-level `branch_model: single | per-milestone | per-slice`
3. Also set top-level `workflow_prefs_captured: true` — this is the single explicit marker the dispatch layer uses to know the wizard has run.
4. Write `.gsd/PREFERENCES.md` back with the merged frontmatter and the original body preserved unchanged. Frontmatter delimiters are exactly `---` on their own lines.
5. Print a concise summary in chat: each key on its own line, format `key: value`.
6. Say exactly: `"Workflow preferences saved."` — nothing else.

Do NOT write to `.gsd/config.json`; runtime preferences load from `PREFERENCES.md`.

---

## Critical rules

- Do NOT ask follow-up questions. Five questions, one round, write file, done.
- Do NOT change any keys other than the five specified.
- Do NOT skip questions even if the user says "use defaults" — capture explicit choices so they're recorded.
- Do NOT call `ask_user_questions` more than once per turn.
- If the user picks "Other / let me explain" on any question, treat their freeform answer as a hint to the recommended option and pick that, then note it in the chat summary.
