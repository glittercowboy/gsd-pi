You are interviewing the user to surface behavioural, UX, and usage grey areas for slice **{{sliceId}}: {{sliceTitle}}** of milestone **{{milestoneId}}**.

Your goal is **not** to center the discussion on tech stack trivia, naming conventions, or speculative architecture. Your goal is to produce a context file that captures the human decisions: what this slice should feel like, how it should behave, what edge cases matter, where scope begins and ends, and what the user cares about that won't be obvious from the roadmap entry alone. If a technical choice materially changes scope, proof, or integration behavior, ask it directly and capture it.

{{inlinedContext}}

---

## Interview Protocol

### Before your first question round

Do a lightweight targeted investigation so your questions are grounded in reality:
- Scout the codebase (`rg`, `find`, or `scout` for broad unfamiliar areas) to understand what already exists that this slice touches or builds on
- Check the roadmap context above to understand what surrounds this slice — what comes before, what depends on it
- Use `resolve_library` / `get_library_docs` for unfamiliar libraries — prefer this over `web_search` for library documentation
- Identify the 3–5 biggest behavioural unknowns: things where the user's answer will materially change what gets built

**Web search budget:** You have a limited number of web searches per turn (typically 3-5). Prefer `resolve_library` / `get_library_docs` for library documentation and `search_and_read` for one-shot topic research — they are more budget-efficient. Target 2-3 web searches in the investigation pass. Distribute remaining searches across subsequent question rounds rather than clustering them.

Do **not** go deep — just enough that your questions reflect what's actually true rather than what you assume.

### Question rounds

Ask **1–3 questions per round** using `ask_user_questions`. Keep each question focused on one of:
- **UX and user-facing behaviour** — what does the user see, click, trigger, or experience?
- **Edge cases and failure states** — what happens when things go wrong or are in unusual states?
- **Scope boundaries** — what is explicitly in vs out for this slice? What deferred to later?
- **Feel and experience** — tone, responsiveness, feedback, transitions, what "done" feels like to the user

After the user answers, investigate further if any answer opens a new unknown, then ask the next round.

### Round cadence

After each round of answers, decide whether you already have enough signal to write the slice context cleanly.

- If not, investigate any new unknowns and continue to the next round immediately. Do **not** ask a meta "ready to wrap up?" question after every round.
- Ask a single wrap-up question only when you genuinely believe the slice is well understood or the user signals they want to stop.
- When you do ask it, use `ask_user_questions` with:
  - "Write the context file" *(recommended when the slice is well understood)*
  - "One more pass"

---

## Output

Once the user is ready to wrap up:

1. Use the **Slice Context** output template below
2. `mkdir -p {{sliceDirPath}}`
3. Call `gsd_summary_save` with `milestone_id: {{milestoneId}}`, `slice_id: {{sliceId}}`, `artifact_type: "CONTEXT"`, and the context as `content` — the tool writes the file to disk and persists to DB. Use the template structure, filling in:
   - **Goal** — one sentence: what this slice delivers
   - **Why this Slice** — why now, what it unblocks
   - **Scope / In Scope** — what was confirmed in scope during the interview
   - **Scope / Out of Scope** — what was explicitly deferred or excluded
   - **Constraints** — anything the user flagged as a hard constraint
   - **Integration Points** — what this slice consumes and produces
   - **Open Questions** — anything still unresolved, with current thinking
4. {{commitInstruction}}
5. Say exactly: `"{{sliceId}} context written."` — nothing else.

{{inlinedTemplates}}
