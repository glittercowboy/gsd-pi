---
name: btw
description: Ask a quick side question about your current work without derailing the main task. Answers from existing conversation context only — no tool calls, no file reads, single concise response. Use when you need a fast answer from what is already in this session.
---

<objective>
Answer a quick side question using only what is already present in the current conversation context. Do not read files, run commands, search, or use any tools. Give a single, concise response and return focus to the main work.
</objective>

<behavior>
**This is a side question, not a task.**

- Answer only from information already in the conversation (files read, decisions made, code seen, context established)
- Do NOT use any tools — no Read, no Bash, no Grep, no Search
- If the answer requires reading something new, say so briefly and suggest the user ask as a normal prompt instead
- Keep the response short and direct — one to a few sentences unless the question genuinely needs more
- Do not summarize the main work, ask follow-up questions, or offer to do anything else
- After answering, stop — do not prompt for next steps
</behavior>

<quick_start>
Parse the argument after `/btw` as the question. Answer it directly from context.

If no argument is provided, ask: "What did you want to know?"

If the question cannot be answered from current context (requires reading a file, running a command, or information not yet in the session), respond with:
"I'd need to [read X / run Y / look up Z] to answer that — ask it as a normal prompt when you're ready."
</quick_start>

<examples>
**Good uses of /btw:**
- `/btw what was the name of that config file again?` → answers from files already read in session
- `/btw which branch are we on?` → answers from git context already established
- `/btw did we already handle the null case in that function?` → answers from code already reviewed
- `/btw what model does this use?` → answers from code or config already in context

**Not a good fit for /btw (suggest normal prompt):**
- Questions requiring reading a file not yet seen
- Questions requiring running a command
- Questions needing a multi-step answer or follow-up
- Starting a new task or changing direction
</examples>
