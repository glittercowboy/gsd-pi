---
phase: 01
reviewers: [codex]
reviewed_at: 2026-03-28T18:36:00Z
plans_reviewed: [01-01-PLAN.md, 01-02-PLAN.md, 01-03-PLAN.md, 01-04-PLAN.md]
---

# Cross-AI Plan Review — Phase 1

## Codex Review

**Overall**

The decomposition is mostly sensible, but the phase is currently underplanned in three places that matter to shipping the feature: the client networking layer is still bearer-token only, secret rotation cannot work if cookie verification only reads a launch-time env var, and AUTH-01 is not actually delivered because there is no concrete settings UI or safe server API for setting/changing the password. As written, 01-02 and 01-03 look closest to "seems right on paper, breaks against the current codebase".

### Plan 01-01: Crypto module + rate limiter

**Summary**
This is a good first slice. It keeps the cryptography small, dependency-free, and testable, and it matches the stated constraints. The main gaps are around operational details: path handling, atomic secret persistence, and making the rate limiter semantics precise enough that the later routes do not guess wrong.

**Strengths**
- Uses `node:crypto` primitives directly and stays within the "no external crypto deps" constraint.
- Keeps session signing stateless and simple, which is appropriate for a single-user local server.
- TDD first is a good fit for this module because parsing, expiry, and signature edge cases are easy to regress.

**Concerns**
- `MEDIUM`: The plan hardcodes `~/.gsd/web-session-secret`; the codebase already supports custom GSD homes via `appRoot`, so this should follow that contract instead of assuming a fixed home path.
- `MEDIUM`: `checkRateLimit(ip)` is underspecified. It needs to say whether only failed attempts count, whether success clears the bucket, and how tests control time.
- `LOW`: An in-memory `Map` without pruning can grow forever on noisy inputs.
- `MEDIUM`: Secret create/rotate should be atomic and permission-safe; concurrent launches can otherwise race on first-write.

**Suggestions**
- Define the rate limiter API as "check + record failed attempt" or "consume on failure", not a single vague `checkRateLimit`.
- Use injected clock/deps in tests so window rollover is deterministic.
- Resolve the secret path from the existing GSD root and write it with atomic replace semantics plus `0600` permissions.

**Risk Assessment:** `MEDIUM` — the crypto shape is fine, but the persistence and rate-limit contract need to be nailed down before other slices depend on it.

### Plan 01-02: Auth API routes + proxy extension

**Summary**
This plan hits the right surfaces, but it has the most important architectural flaw in the phase: it makes cookie validation depend on a launch-time env secret, which means password changes will not invalidate active sessions in the running server. It also risks weakening the current origin checks if `/api/auth/*` is exempted too early.

**Strengths**
- Correctly puts auth enforcement in the proxy, which is where the current bearer-token gate already lives.
- Keeping auth routes separate from the main API surface is a clean boundary.
- Status route is the right primitive for a login gate UI.

**Concerns**
- `HIGH`: If proxy verification uses `GSD_WEB_SESSION_SECRET` from process env, rotating the secret file later will not invalidate existing cookies because the running Next process keeps the old value from launch.
- `HIGH`: "Exempt `/api/auth/*` before any auth check" is dangerous wording. In the current proxy, origin validation happens before token validation; the auth routes should skip credential checks, not skip origin checks.
- `MEDIUM`: The plan duplicates session verification logic in proxy instead of reusing 01-01, which increases drift risk in a security-sensitive path.
- `MEDIUM`: IP extraction from `x-forwarded-for` / `x-real-ip` needs a clear trust/fallback policy; otherwise rate limiting is easy to bypass or collapses everyone into one bucket.
- `MEDIUM`: This slice implicitly depends on 01-04's storage/secret contract, but that dependency is not stated.

**Suggestions**
- Keep origin validation unconditional; exempt auth routes only from bearer/cookie credential requirements.
- Move "load current password hash + current session secret" behind one server-side auth config module and have both routes and proxy use it.
- Either read the session secret live from durable storage or explicitly reload/restart the auth verifier after rotation.
- Return `Retry-After` on 429 so the UI countdown has a canonical server value.

**Risk Assessment:** `HIGH` — this is the core security slice, and as written it does not satisfy immediate invalidation on password change.

### Plan 01-03: Login gate UI + page wiring

**Summary**
The UX decisions are solid, but the implementation scope is too small for the current client architecture. Today the frontend assumes "no bearer token means synthetic 401 before any request is sent", so cookie auth will not work until the shared auth client is refactored.

**Strengths**
- Correctly captures the hard-reload requirement after login.
- Good attention to UX details: autofocus, loading state, inline errors, rate-limit countdown.
- Wrapping the app shell at the page boundary is the right place for the gate.

**Concerns**
- `HIGH`: Cookie auth cannot boot with the current client auth layer. `web/lib/auth.ts` returns a synthetic 401 whenever there is no bearer token, so the app never sends the cookie-backed request at all.
- `HIGH`: The plan ignores additive bearer-token fallback on HTTPS. If the gate only calls `/api/auth/status` and that route only checks cookies, a valid bearer token on HTTPS will still be treated as unauthenticated, which conflicts with AUTH-08.
- `MEDIUM`: D-04/D-05 are not actually covered yet. The current code only has explicit 401 handling on boot refresh; other fetches and SSE reconnect failures will not automatically redirect to login.
- `MEDIUM`: `clearAuth()` needs to clear in-memory token state too; the current `storage` listener only handles writes, not removals.
- `MEDIUM`: No "password not configured" state is planned for HTTPS users, so they may hit a dead-end instead of actionable guidance.

**Suggestions**
- Expand this slice to refactor `authFetch` and SSE auth into dual-mode behavior: bearer when present, plain same-origin requests otherwise.
- Treat "existing bearer token" as authenticated in the gate, or make `/api/auth/status` understand both cookie and bearer auth.
- Centralize 401 handling in the shared auth client/store so expired-cookie behavior is consistent across boot, actions, and stream reconnects.
- Add a dedicated UI state for "remote password not configured".

**Risk Assessment:** `HIGH` — the UX is well thought out, but the current implementation plan does not actually connect to the existing bearer-centric client runtime.

### Plan 01-04: Password storage service + secret env injection

**Summary**
This slice is the least complete relative to the phase requirements. It handles hashing and rotation, but it does not actually give the user a settings-side way to set/change the password, and the env-injection approach conflicts with the "invalidate all sessions immediately" requirement.

**Strengths**
- Hash-on-write plus rotate-on-change is the right lifecycle.
- Preserving unrelated web preferences is the correct behavior for a brownfield file-backed settings store.

**Concerns**
- `HIGH`: AUTH-01 is not really delivered here. There is no concrete settings API or UI plan for setting/changing the password from the existing settings surfaces.
- `HIGH`: If `passwordHash` is stored in `web-preferences.json` without redaction, the existing preferences endpoint will return it to the client.
- `HIGH`: Secret rotation still does not invalidate active sessions if the proxy/login code only reads the env injected at launch.
- `MEDIUM`: Putting password persistence in `web-settings-service.ts` muddles responsibilities with the existing read-only aggregation service.
- `MEDIUM`: Marking secret-read failure as non-fatal can leave the system in a confusing state: password configured, remote login expected, cookie auth silently disabled.
- `MEDIUM`: The plan does not mention protecting `web-preferences.json` with restrictive file permissions, even though it will now hold authentication material.

**Suggestions**
- Add a dedicated auth settings endpoint and a dedicated settings panel for set/change/clear password.
- Redact auth fields from generic preferences reads, or store auth data in a separate file/service.
- Do not rely on launch-time env for revocation-sensitive secrets.
- Enforce the same password validation rules at set time, not only at login time.

**Risk Assessment:** `HIGH` — as written, this slice does not fully satisfy AUTH-01 or AUTH-07 and creates a likely data-leak path through the existing preferences API.

---

## Consensus Summary

*Single reviewer — no cross-reviewer consensus to synthesize. Key themes below.*

### Top Concerns (HIGH severity)

1. **Launch-time secret injection breaks session invalidation** — proxy.ts reads `GSD_WEB_SESSION_SECRET` from env at startup. Password change rotates the secret file, but the running server keeps the old value. Sessions are NOT invalidated until server restart. (Plans 01-02, 01-04)
2. **Client auth layer blocks cookie-based requests** — `web/lib/auth.ts` returns synthetic 401 when no bearer token is present, preventing cookie-authenticated requests from ever reaching the server. (Plan 01-03)
3. **Origin check bypass risk** — Exempting `/api/auth/*` from all proxy checks (not just credential checks) may skip the existing Origin validation, weakening CSRF protection. (Plan 01-02)
4. **Password hash leak via preferences API** — Storing `passwordHash` in `web-preferences.json` exposes it through the existing GET preferences endpoint. (Plan 01-04)
5. **No settings UI/API for password management** — AUTH-01 requires users to set passwords via settings, but no plan includes the actual UI or API endpoint for this. (Plan 01-04)

### Strengths

- Clean 4-plan decomposition with clear wave ordering
- TDD approach for security-critical crypto module
- Well-thought-out UX decisions (D-01 through D-10)
- Correct use of node:crypto primitives (no external deps)
- Backward compatibility design (localhost unchanged)

### Actionable Items for Replanning

1. Replace launch-time env injection with live secret reads (or server restart on rotation)
2. Refactor `authFetch` to support cookie-only mode (no bearer token on HTTPS)
3. Narrow the `/api/auth/*` exemption to credential checks only, preserve Origin validation
4. Store auth data separately from web-preferences.json, or redact from the preferences endpoint
5. Add a password management API endpoint + settings UI task

---

*Review completed: 2026-03-28*
*Reviewer: Codex (gpt-5.4)*
