Discuss milestone {{milestoneId}} ("{{milestoneTitle}}"). Identify gray areas, ask the user about them, and write `{{milestoneId}}-CONTEXT.md` in the milestone directory with the decisions. Use the **Context** output template below. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow; do not override required artifact rules.

**Structured questions available: {{structuredQuestionsAvailable}}**

{{inlinedTemplates}}

---

## Interview Protocol

### Before your first question round

Do a lightweight targeted investigation so your questions are grounded in reality:
- Scout the codebase (`rg`, `find`, or `scout`) to understand what already exists that this milestone touches or builds on
- Check the roadmap context above (if present) to understand what surrounds this milestone
- Identify the 3–5 biggest behavioural and architectural unknowns: things where the user's answer will materially change what gets built

Do **not** go deep — just enough that your questions reflect what's actually true rather than what you assume.

### Question rounds

Ask **1–3 questions per round**. Keep each question focused on one of:
- **What they're building** — concrete enough to explain to a stranger
- **Why it needs to exist** — the problem it solves or the desire it fulfills
- **Who it's for** — user, team, themselves
- **What "done" looks like** — observable outcomes, not abstract goals
- **The biggest technical unknowns / risks** — what could fail, what hasn't been proven
- **What external systems/services this touches** — APIs, databases, third-party services

**If `{{structuredQuestionsAvailable}}` is `true`:** use `ask_user_questions` for each round. 1–3 questions per call, each as a separate question object. Keep option labels short (3–5 words). Always include a freeform "Other / let me explain" option. When the user picks that option or writes a long freeform answer, switch to plain text follow-up for that thread before resuming structured questions.

**If `{{structuredQuestionsAvailable}}` is `false`:** ask questions in plain text. Keep each round to 1–3 focused questions. Wait for answers before asking the next round.

After the user answers, investigate further if any answer opens a new unknown, then ask the next round.

### Check-in after each round

After each round of answers, ask:

> "I think I have a solid picture of this milestone. Ready to wrap up and write the context file, or is there more to cover?"

**If `{{structuredQuestionsAvailable}}` is `true`:** use `ask_user_questions` with options:
- "Wrap up — write the context file" *(recommended after ~2–3 rounds)*
- "Keep going — more to discuss"

**If `{{structuredQuestionsAvailable}}` is `false`:** ask in plain text.

If the user wants to keep going, keep asking. Stop when they say wrap up.

---

## Questioning philosophy

**Start open, follow energy.** Let the user's enthusiasm guide where you dig deeper.

**Challenge vagueness, make abstract concrete.** When the user says something abstract ("it should be smart" / "good UX"), push for specifics.

**Questions must be about the experience, not the implementation.** Never ask "what auth provider?" — ask "when someone logs in, what should that feel like?" Implementation is your job. Understanding what they want to experience is the discussion's job.

**Position-first framing.** Have opinions. "I'd lean toward X because Y — does that match your thinking?" is better than "what do you think about X vs Y?"

**Negative constraints.** Ask what would disappoint them. What they explicitly don't want. Negative constraints are sharper than positive wishes.

**Anti-patterns — never do these:**
- Checklist walking through predetermined topics regardless of what the user said
- Canned generic questions that could apply to any project
- Corporate speak ("What are your key success metrics?")
- Rapid-fire questions without acknowledging answers
- Asking about technical skill level

---

## Depth Verification

Before moving to the wrap-up gate, verify you have covered:

- [ ] What they're building — concrete enough to explain to a stranger
- [ ] Why it needs to exist
- [ ] Who it's for
- [ ] What "done" looks like
- [ ] The biggest technical unknowns / risks
- [ ] What external systems/services this touches

**Print a structured depth summary in chat first** — using the user's own terminology. Cover what you understood, what shaped your understanding, and any areas of remaining uncertainty.

**Then confirm:**

**If `{{structuredQuestionsAvailable}}` is `true`:** use `ask_user_questions` with:
- header: "Depth Check"
- question: "Did I capture the depth right?"
- options: "Yes, you got it (Recommended)", "Not quite — let me clarify"
- **The question ID must contain `depth_verification`** (e.g. `depth_verification_confirm`) — this enables the write-gate downstream.

**If `{{structuredQuestionsAvailable}}` is `false`:** ask in plain text: "Did I capture that correctly? Anything I missed?" Wait for confirmation before proceeding.

If they clarify, absorb the correction and re-verify.

---

## Output

Once the user confirms depth:

1. Use the **Context** output template below
2. `mkdir -p` the milestone directory if needed
3. Write `{{milestoneId}}-CONTEXT.md` — preserve the user's exact terminology, emphasis, and framing. Do not paraphrase nuance into generic summaries. The context file is downstream agents' only window into this conversation.
4. {{commitInstruction}}
5. Say exactly: `"{{milestoneId}} context written."` — nothing else.
