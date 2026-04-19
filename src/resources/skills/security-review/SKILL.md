---
name: security-review
description: Threat-model-driven security review of a change, feature, or subsystem. Runs a STRIDE-style pass (Spoofing, Tampering, Repudiation, Info disclosure, Denial of service, Elevation of privilege), examines the actual code, and produces a filing-ready report with severity, exploit scenario, and concrete remediation. Use when asked to "security review", "threat model", "check for vulnerabilities", "audit this for security", "secure this", or before shipping any change that touches auth, input handling, data access, or external surfaces.
---

<objective>
Produce a security review that names specific exploit paths through the actual code — not a generic checklist. The deliverable is a prioritized list of findings, each with: where the issue lives, the threat category, a concrete exploit scenario, severity, and a remediation the caller can implement. Read-only: does not modify code.
</objective>

<context>
GSD-2's general `review` skill covers security as one of several categories. This skill is the deeper pass — triggered deliberately when security is the primary concern. It complements v1's `/gsd-secure-phase` concept, adapted to the gsd-2 artifact model.

Invocation points:
- Any change touching authentication, authorization, session handling
- Any change touching user input → database, filesystem, or shell
- Any change exposing a new external surface (HTTP endpoint, webhook, IPC boundary)
- Secrets handling, environment variable changes, crypto code
- Pre-release audit of a feature or milestone
- Response to a suspected vulnerability

Do NOT use for:
- General code review (use `review`)
- Performance audits (use `code-optimizer`)
</context>

<core_principle>
**CODE BEFORE CHECKLISTS.** A threat model that doesn't read the code is theater. Find the actual input source, the actual validation (or absence), the actual sink. Cite file:line for every finding.

**THREAT, NOT HYPOTHETICAL.** "SQL injection is possible in theory" is useless. "If an attacker passes `' OR 1=1--` to `getUser(name)` at `src/db/users.ts:42`, the query becomes `SELECT … WHERE name='' OR 1=1--'`, returning every row" is actionable.

**READ-ONLY.** Don't patch while reviewing — you conflate reviewer and author and lose the audit trail. Report, let the user act.
</core_principle>

<process>

## Step 1: Scope the review

Identify what to review:
- Recent diff (staged / branch / specific commit)
- A named subsystem (`src/auth/`, the webhook handler, etc.)
- A user-provided concern ("I'm worried about our JWT handling")

If the scope is vague, ask one round of clarifying questions (1–3 questions). Otherwise proceed.

## Step 2: Map the attack surface

Before STRIDE: identify every untrusted entry point in the scope:

- HTTP routes / GraphQL resolvers / RPC endpoints
- CLI flag parsing and argv consumption
- Webhook handlers, event subscribers
- Environment variables read at runtime
- Files read from untrusted locations
- Third-party library deserialization (YAML, XML, pickle, etc.)
- IPC boundaries, child processes

For each, note: who can reach this surface? (public internet, authenticated user, same-host process, admin-only).

## Step 3: STRIDE pass

For each attack surface, walk STRIDE:

### Spoofing (identity)
- Can an attacker pretend to be another user?
- Are identity tokens verified before they're trusted?
- Session cookies: HttpOnly, Secure, SameSite set?

### Tampering (integrity)
- Can an attacker modify data in transit or at rest?
- Are webhooks signed and signatures verified?
- Are incoming payloads rehydrated without integrity checks?

### Repudiation (audit trail)
- Is there a log of who did what?
- Can an attacker erase their trail?
- Are logs tamper-evident where it matters?

### Information disclosure
- Does an error message leak internal state, stack traces, file paths, DB queries?
- Are secrets logged anywhere?
- Are authorization checks upstream of data loading, or does the query run first?

### Denial of service
- Are there unbounded loops, unpaginated queries, or user-controlled recursion?
- Rate limits on expensive endpoints?
- Regex-on-user-input vulnerable to ReDoS?

### Elevation of privilege
- Are admin-only routes actually gated?
- Can a low-privilege user trigger a high-privilege operation through an unauthenticated webhook?
- Are role checks enforced at the handler, the service, and the data layer — or just one?

Use `Agent(subagent_type=Explore)` in parallel if the scope is large — one sub-agent per STRIDE category over the same surface list.

## Step 4: OWASP cross-check (web scope)

If the scope includes web surfaces, confirm against the top OWASP patterns that STRIDE doesn't cleanly cover:

- Injection (SQL, NoSQL, command, template, LDAP)
- XSS (stored, reflected, DOM)
- SSRF (server makes requests to attacker-controlled URLs)
- Insecure deserialization
- Path traversal
- Open redirects
- Broken access control at object level (IDOR)
- CSRF where cookies are used for auth

For each present, find the code path. Same standard: cite file:line.

## Step 5: Triage

For each finding, assign:

- **Severity:** Critical / High / Medium / Low / Informational
- **Exploitability:** Remote unauthenticated / authenticated user / adjacent user / admin-only / local-only
- **Business impact:** Data breach / account takeover / service disruption / audit failure / minor

Severity × Exploitability = priority. Sort findings by priority.

## Step 6: Write the report

```markdown
## Security Review — <scope>

### Summary

<1–3 sentences — biggest finding and overall posture>

### Findings

#### CRITICAL-1: SQL injection in `getUser`

**Location:** `src/db/users.ts:42`
**Category:** Tampering / Info disclosure (STRIDE) + OWASP A03 Injection
**Exploit:** Passing `' OR 1=1--` to the `name` parameter produces the query `SELECT * FROM users WHERE name='' OR 1=1--'`, returning every row. `name` arrives from `POST /api/search` without validation.
**Reachability:** Remote unauthenticated (endpoint has no auth).
**Remediation:** Use a parameterized query. The codebase's `db.prepare` helper at `src/db/util.ts:17` handles this — switch `getUser` to it.

#### HIGH-2: ...

### Non-findings considered

<brief: what you checked and ruled out — prevents repeat reviews>

### Out of scope

<what wasn't reviewed>
```

Offer to file as a GitHub issue — requires explicit confirmation per the outward-action rule. Sensitive findings should stay in `.gsd/security-reviews/` and not be pushed to a public tracker; check the repository's security policy first.

## Step 7: Follow-ups

If the review found CRITICAL or HIGH issues:
- Recommend filing a private security advisory (not a public issue) if the repo is public.
- Flag the finding for `/gsd start hotfix` if it's in the scope of active work.
- Append one line to `.gsd/DECISIONS.md` if the remediation involves an architectural change.

</process>

<anti_patterns>

- **Generic checklists.** "Does it validate input?" yes/no without pointing at the code is not a review.
- **Hypothetical exploits without code.** If you can't name the path, the finding isn't real yet.
- **Modifying code during review.** Reviewer and author must stay separate.
- **Treating every theoretical issue as CRITICAL.** Severity requires exploitability.
- **Skipping reachability.** A "critical" behind admin-only auth is usually not critical.
- **Filing sensitive findings publicly.** Check the repo's security policy first.

</anti_patterns>

<success_criteria>

- [ ] Every finding cites a file:line.
- [ ] Every finding has a concrete exploit scenario, not just a category.
- [ ] Severity, exploitability, and business impact are stated.
- [ ] At least one non-finding is listed (shows what was ruled out).
- [ ] No code was modified during the review.
- [ ] Critical findings are routed through an appropriate disclosure channel, not auto-filed publicly.

</success_criteria>
