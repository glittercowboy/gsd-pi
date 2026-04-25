# Accessibility Audit

<template_meta>
name: accessibility-audit
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Scan the UI layer for accessibility issues and produce a prioritized remediation
list. Oneshot — report only, no code changes.
</purpose>

<instructions>

## 1. Identify the UI stack

- React, Vue, Svelte, Angular, plain HTML, or something else?
- Which files contain user-facing templates? (e.g. `src/components/**/*.tsx`,
  `pages/**/*.vue`, `templates/**/*.html`).

If the project has no UI layer (library, CLI, backend), say so and stop.

## 2. Run available a11y tooling

Prefer automated tools when installed:
- React: `@axe-core/react`, `eslint-plugin-jsx-a11y`.
- Vue: `eslint-plugin-vuejs-accessibility`.
- Any: `pa11y` or `axe` against a running dev server.

If nothing's installed, do a **static audit**: grep for the common
violations listed below.

## 3. Check the WCAG essentials

For each component/page:

1. **Images** without `alt`.
2. **Buttons** that are `<div onClick>` instead of real `<button>`.
3. **Links** without `href` or with only an icon and no label.
4. **Form inputs** without an associated `<label>` or `aria-label`.
5. **Color-only** state indicators (errors shown only with red, etc.).
6. **Focus management**: missing `:focus-visible`, tab traps, hidden focus.
7. **Headings** that skip levels (`h1` → `h3` with no `h2`).
8. **ARIA**: `role=button` on divs (should just be a button), misuse of
   `aria-label` on elements that already have accessible text.
9. **Landmark regions**: missing `<main>`, `<nav>`, `<header>`.
10. **Keyboard traps**: modals/dialogs without escape handlers.

## 4. Triage by severity

- **Blocker** (P0) — prevents a user from completing a core task with
  keyboard / screen reader.
- **Serious** (P1) — materially degrades the experience but workable.
- **Moderate** (P2) — fixable, would benefit most users.
- **Minor** (P3) — polish.

## 5. Output

```
# A11y Audit — <date>

## Summary
<scope — how many components/pages reviewed, tool coverage>

## Blockers (P0) — <n>
- file:line — issue
  Fix: <specific code suggestion>

## Serious (P1) — <n>
...

## Moderate / Minor
...

## Top 5 Recommendations
1. <highest-impact fix first>
```

## 6. Don't refactor

Suggestions should be specific enough to act on, but don't edit any files.
If the user wants to apply the fixes, suggest:
> `/gsd workflow refactor "apply a11y fixes"` with this report as context.

</instructions>
