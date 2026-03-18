---
depends_on: [M010]
---

# M011: CI/CD, Packaging & PWA

**Gathered:** 2026-03-18
**Status:** Draft — needs dedicated discussion before planning

## What This Milestone Does

Three production-readiness concerns: (1) a separate web.yml CI workflow that builds and tests the web host, (2) verification that the npm tarball properly packages the web standalone host for consumer installs, and (3) PWA install prompt with Serwist so users can install GSD as a desktop app.

## Why It Matters

The web host has never been part of CI — regressions ship silently. The packaging path (npm pack → install → gsd --web) has never been formally verified end-to-end. And a PWA install prompt gives users a native-app-like experience without Electron overhead.

## Key Facts from Current Investigation

- Current CI: ci.yml has build + typecheck + validate-pack + unit/integration tests. No web build or web tests.
- Build-native.yml exists for native package builds.
- package.json files field includes "dist/web" — staging script copies standalone output there.
- validate-pack.js exists but doesn't verify web host presence in tarball.
- No PWA infrastructure exists (no manifest.json, no service worker).
- Serwist (@serwist/next) is the modern fork of next-pwa for Next.js App Router.
- Web icons already exist in web/public/ (apple-icon.png, icon-dark-32x32.png, etc.)

## User Decisions

- Separate web.yml workflow (not adding to existing ci.yml)
- PWA scope: install prompt + app shell caching only, no offline functionality
- Must pass on push to main

## Relevant Requirements

- R112/R130 — Separate web CI workflow
- R131 — npm tarball includes web standalone
- R132 — All CI passes green on main
- R133 — PWA install prompt with manifest and service worker

## Open Questions for Dedicated Discussion

- Should web.yml run on the same triggers as ci.yml (push to main/feat/**, PR to main)?
- Should validate-pack be extended to check for dist/web/standalone, or should web.yml have its own validation?
- PWA manifest theming — should it match the dark theme default or be neutral?
- Whether the PWA should prompt on first --web launch or be a setting
