# Claude Code Auth Compliance Research

Date: 2026-04-10

## Executive Summary

Anthropic's current public guidance draws a hard line:

- Native Anthropic apps, including Claude Code, may use Claude subscription authentication.
- Third-party tools should prefer API key authentication through Claude Console or a supported cloud provider.
- Apps that misrepresent their identity, route third-party traffic against subscription limits, or otherwise violate Anthropic terms are explicitly prohibited.

For GSD2, the safe path is:

1. Treat local Claude Code as an external authenticated runtime.
2. Never ask GSD users to sign into Claude subscriptions through GSD-managed Anthropic OAuth.
3. Never exchange Claude.ai subscription OAuth into a bearer token and call Anthropic APIs as if GSD were Claude Code.
4. If GSD needs direct Anthropic API access, require a Claude Console API key, Bedrock, Vertex, or another explicitly supported provider path.

## What Anthropic Explicitly Allows

### 1. Claude Code itself can use Claude subscription auth

Anthropic's help center says Claude Pro/Max users should install Claude Code, run `claude`, and "log in with the same credentials you use for Claude." It also says this connects the subscription directly to Claude Code, and that `/login` is the way to switch account types. The Team/Enterprise article gives the same flow for org accounts.

Implication for GSD2:

- Letting users authenticate inside the real `claude` CLI is aligned with Anthropic's documented flow.
- Detecting `claude auth status` and routing work through the local CLI or official Claude Code SDK is the lowest-risk pattern.

### 2. Claude Code supports both subscription OAuth and API credentials

Anthropic's Claude Code docs say supported auth types include Claude.ai credentials, Claude API credentials, Azure Auth, Bedrock Auth, and Vertex Auth. The docs also define auth precedence:

1. cloud provider credentials
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`
4. `apiKeyHelper`
5. subscription OAuth from `/login`

Implication for GSD2:

- If GSD2 shells out to or embeds Claude Code, it should respect Claude Code's own credential selection instead of inventing a parallel Anthropic OAuth flow.
- `apiKeyHelper` is the clean enterprise escape hatch when an org wants dynamic short-lived keys without handing raw API keys to the tool.

### 3. Anthropic commercial usage is available through API keys and supported cloud providers

Anthropic's commercial terms govern API keys and related Anthropic services for customer-built products, including products made available to end users. The authentication docs for teams recommend Claude for Teams/Enterprise, Claude Console, Bedrock, Vertex, or Microsoft Foundry.

Implication for GSD2:

- If GSD2 is acting as a product for users, direct Anthropic access should be through commercial auth paths, not subscription-token reuse.

## What Anthropic Explicitly Warns Against

Anthropic's current "Logging in to your Claude account" article is the clearest statement:

- Subscription plans are for ordinary use of native Anthropic apps, including Claude web, desktop, mobile, and Claude Code.
- "The preferred way" for third-party tools, including open-source projects, is API key auth through Claude Console or a supported cloud provider.
- If you're building a product, application, or tool for others, use API key auth through Claude Console or a supported cloud provider.
- Tools that misrepresent identity, route third-party traffic against subscription limits, or otherwise violate terms are prohibited.

Anthropic's consumer terms add two more constraints:

- Users may not share account login info, API keys, or account credentials with anyone else.
- Except when accessing services via an Anthropic API key or where Anthropic explicitly permits it, users may not access the services through automated or non-human means.

Implication for GSD2:

- A GSD-managed Anthropic OAuth flow for subscription accounts is high risk.
- Reusing user Claude subscription credentials inside GSD's own API client is high risk.
- Any flow that makes Anthropic believe requests come from Claude Code when they actually come from GSD infrastructure is out of bounds.

## Current GSD2 Findings

### Low-risk / aligned pieces

- `src/resources/extensions/claude-code-cli/index.ts`
  Registers `claude-code` as an `externalCli` provider and routes through Anthropic's official `@anthropic-ai/claude-agent-sdk`.
- `src/resources/extensions/claude-code-cli/readiness.ts`
  Only checks local CLI presence and auth state via `claude --version` and `claude auth status`.
- `src/onboarding.ts`
  TUI onboarding already removed Anthropic browser OAuth and labels local Claude Code routing as the TOS-compliant path.
- `src/cli.ts`
  Migrates users from `anthropic` to `claude-code` when the local CLI is available.

These are directionally correct because GSD is using the user's own local Claude Code installation as the authenticated Anthropic surface.

### Medium/high-risk pieces — RESOLVED

All Anthropic OAuth code paths have been removed:

- `packages/pi-ai/src/utils/oauth/anthropic.ts` — **Deleted.** No longer implements Anthropic OAuth flow.
- `packages/pi-ai/src/utils/oauth/index.ts` — **Updated.** `anthropicOAuthProvider` removed from built-in registry.
- `src/web/onboarding-service.ts` — **Updated.** Anthropic set to `supportsOAuth: false`.
- `packages/daemon/src/orchestrator.ts` — **Updated.** OAuth token refresh removed; requires `ANTHROPIC_API_KEY` env var.
- `packages/pi-ai/src/providers/anthropic.ts` — **Updated.** OAuth client branch removed; `isOAuthToken` always returns false.

## Recommended Policy For GSD2

Adopt this as the repo rule:

- Claude subscription auth is allowed only inside Anthropic-owned surfaces:
  - the `claude` CLI
  - Claude Code SDK when it is backed by the local authenticated Claude Code install
  - other Anthropic-documented native flows
- GSD2 must not implement its own Anthropic subscription OAuth flow for end users.
- GSD2 must not persist Anthropic subscription OAuth tokens for later API use.
- GSD2 must not send Anthropic API traffic using subscription OAuth tokens obtained by GSD.
- GSD2 may support Anthropic direct access only via:
  - `ANTHROPIC_API_KEY`
  - Claude Console API keys stored in auth storage
  - `apiKeyHelper`
  - Bedrock / Vertex / Foundry
  - the local Claude Code provider

## Recommended Implementation Plan

### Option A: Safe minimal compliance cleanup

1. Remove Anthropic from the built-in OAuth provider registry.
2. Change web onboarding so Anthropic is API-key only.
3. Keep `claude-code` as the recommended path when `claude auth status` succeeds.
4. Add explicit UI copy:
   - "Claude subscription users: sign into the local Claude Code app/CLI, not GSD."
5. Block migrations or code paths that convert Anthropic OAuth credentials into API auth for GSD-managed requests.

This is the fastest path to align the repo with Anthropic's published guidance.

### Option B: Enterprise-safe Anthropic support

Support three distinct Anthropic modes:

- `claude-code`
  Uses the local authenticated `claude` runtime only.
- `anthropic-api`
  Uses Console API keys or `apiKeyHelper`.
- `anthropic-cloud`
  Uses Bedrock, Vertex, or Foundry.

Then remove any ambiguous `anthropic` browser-login path entirely.

This is the best long-term UX because it separates:

- subscription-native usage
- API-billed usage
- cloud-routed usage

## Concrete Repo Follow-ups — COMPLETED

1. ~~Delete or disable `packages/pi-ai/src/utils/oauth/anthropic.ts`.~~ **Done** — file deleted.
2. ~~Remove `anthropicOAuthProvider` from `packages/pi-ai/src/utils/oauth/index.ts`.~~ **Done.**
3. ~~Change `src/web/onboarding-service.ts` so Anthropic does not claim OAuth support.~~ **Done.**
4. ~~Audit `packages/daemon/src/orchestrator.ts` and any other callers that treat Anthropic OAuth access tokens as API credentials.~~ **Done** — daemon now requires `ANTHROPIC_API_KEY`.
5. ~~Update docs/UI labels to prefer `anthropic-api` for direct API usage and `claude-code` for subscription usage.~~ **Done** — providers.md and getting-started.md updated.
6. Add tests that fail if Anthropic subscription OAuth is reintroduced through the onboarding/provider registry. — **TODO.**

## Decision Rule

If a proposed GSD2 feature needs Anthropic access, ask one question:

"Is GSD calling Anthropic as GSD, or is GSD delegating to the user's already-authenticated local Claude Code runtime?"

- If GSD is calling Anthropic as GSD: require API key or supported cloud auth.
- If GSD is delegating to local Claude Code: acceptable, as long as GSD does not intercept, mint, or replay subscription credentials itself.

## Sources Reviewed

- Anthropic Help Center: "Logging in to your Claude account"
- Anthropic Help Center: "Using Claude Code with your Pro or Max plan"
- Anthropic Help Center: "Use Claude Code with your Team or Enterprise plan"
- Anthropic Help Center: "Managing API key environment variables in Claude Code"
- Anthropic Help Center: "API Key Best Practices: Keeping Your Keys Safe and Secure"
- Claude Code Docs: getting started / authentication / team / settings / IAM
- Anthropic Commercial Terms of Service
- Anthropic Consumer Terms of Service
- Anthropic Usage Policy
