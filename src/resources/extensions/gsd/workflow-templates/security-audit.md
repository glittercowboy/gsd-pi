# Security Audit Workflow

<template_meta>
name: security-audit
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/audits/
</template_meta>

<purpose>
Systematic security review of the codebase. Scan for vulnerabilities, triage
findings by severity, remediate issues, and verify fixes. Covers OWASP Top 10,
dependency vulnerabilities, and project-specific security concerns.
</purpose>

<phases>
1. scan       — Identify potential vulnerabilities
2. triage     — Prioritize findings by severity and exploitability
3. remediate  — Fix critical and high-severity issues
4. re-scan    — Verify fixes and document remaining items
</phases>

<process>

## Phase 1: Scan

**Goal:** Identify potential security issues across the codebase.

1. **Dependency audit:** Run `npm audit` / `pip audit` / equivalent
2. **Code review for common vulnerabilities:**
   - Injection (SQL, command, XSS)
   - Authentication/authorization flaws
   - Sensitive data exposure (hardcoded secrets, logs)
   - Insecure configuration
   - Missing input validation at boundaries
3. **Check security headers and CORS** (if web application)
4. **Review secrets management:** .env files, config, environment variables
5. **Produce:** Write `SCAN-RESULTS.md` with all findings

## Phase 2: Triage

**Goal:** Prioritize what to fix now vs later.

1. **Rate each finding:**
   - Critical: exploitable, high impact, fix immediately
   - High: likely exploitable, fix in this workflow
   - Medium: lower risk, fix if time allows
   - Low: informational, document for later
2. **Assess exploitability:** Is this theoretical or practically exploitable?
3. **Produce:** Update `SCAN-RESULTS.md` with severity ratings and triage decisions

4. **Gate:** Review triage with user. Agree on what to remediate now.

## Phase 3: Remediate

**Goal:** Fix critical and high-severity issues.

1. Fix each issue with proper testing
2. Commit each fix individually: `fix(security): <description>`
3. Don't introduce new functionality — security fixes only

## Phase 4: Re-scan

**Goal:** Verify fixes and document the final state.

1. Re-run the scans from Phase 1
2. Verify all targeted issues are resolved
3. **Produce:** Write `AUDIT-REPORT.md` with:
   - Summary of findings and fixes
   - Remaining medium/low items for future attention
   - Recommendations for ongoing security practices

</process>
