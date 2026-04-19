import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertValidDebugSessionSlug,
  createDebugSession,
  debugSessionArtifactPath,
  debugSessionsDir,
  listDebugSessions,
  loadDebugSession,
  slugifyDebugSessionIssue,
  updateDebugSession,
  type DebugCheckpoint,
  type DebugSpecialistReview,
  type DebugTddGate,
} from "../debug-session-store.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-session-store-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

describe("debug-session-store: create/list/load/update", () => {
  test("creates first session under .gsd/debug/sessions with deterministic metadata", () => {
    const base = makeBase();
    try {
      const created = createDebugSession(base, {
        issue: "Login fails on Safari",
        createdAt: 1000,
      });

      assert.equal(created.session.slug, "login-fails-on-safari");
      assert.ok(created.artifactPath.includes(join(".gsd", "debug", "sessions")));
      assert.ok(created.artifactPath.endsWith("login-fails-on-safari.json"));
      assert.ok(created.session.logPath.includes(join(".gsd", "debug")));
      assert.ok(!created.session.logPath.includes(join("debug", "sessions")));
      assert.equal(created.session.status, "active");
      assert.equal(created.session.phase, "queued");
      assert.equal(created.session.createdAt, 1000);
      assert.equal(created.session.updatedAt, 1000);

      assert.ok(existsSync(created.artifactPath), "session artifact should exist");
      const raw = readFileSync(created.artifactPath, "utf-8");
      assert.ok(raw.includes('"slug": "login-fails-on-safari"'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("collision-safe slugging allows multiple same-title sessions", () => {
    const base = makeBase();
    try {
      const a = createDebugSession(base, { issue: "Auth issue" });
      const b = createDebugSession(base, { issue: "Auth issue" });
      const c = createDebugSession(base, { issue: "Auth issue" });

      assert.equal(a.session.slug, "auth-issue");
      assert.equal(b.session.slug, "auth-issue-2");
      assert.equal(c.session.slug, "auth-issue-3");
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue")));
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue-2")));
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue-3")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("list returns deterministic ordering by updatedAt desc then slug", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "First", createdAt: 100 });
      createDebugSession(base, { issue: "Second", createdAt: 200 });
      createDebugSession(base, { issue: "Third", createdAt: 300 });

      updateDebugSession(base, "first", { phase: "triage", updatedAt: 500 });

      const listed = listDebugSessions(base);
      assert.equal(listed.malformed.length, 0);
      assert.deepEqual(
        listed.sessions.map(s => s.session.slug),
        ["first", "third", "second"],
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("load returns null when slug does not exist", () => {
    const base = makeBase();
    try {
      const loaded = loadDebugSession(base, "missing-slug");
      assert.equal(loaded, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("update persists status/phase/error metadata for observability", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Rate limit flake", createdAt: 10 });
      const updated = updateDebugSession(base, "rate-limit-flake", {
        status: "failed",
        phase: "diagnosing",
        lastError: "Timeout waiting for health check",
        updatedAt: 42,
      });

      assert.equal(updated.session.status, "failed");
      assert.equal(updated.session.phase, "diagnosing");
      assert.equal(updated.session.lastError, "Timeout waiting for health check");
      assert.equal(updated.session.updatedAt, 42);

      const listed = listDebugSessions(base);
      assert.equal(listed.sessions[0].session.status, "failed");
      assert.equal(listed.sessions[0].session.phase, "diagnosing");
      assert.equal(listed.sessions[0].session.updatedAt, 42);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("debug-session-store: malformed artifacts + negative paths", () => {
  test("list continues healthy sessions while surfacing malformed artifact paths", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      const sessionsPath = debugSessionsDir(base);
      writeFileSync(join(sessionsPath, "corrupt.json"), "{ this is not json", "utf-8");

      const listed = listDebugSessions(base);
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].session.slug, "healthy-issue");
      assert.equal(listed.malformed.length, 1);
      assert.ok(listed.malformed[0].artifactPath.endsWith(join("sessions", "corrupt.json")));
      assert.match(listed.malformed[0].message, /parse debug session artifact/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects empty issue text and unsupported tokens that slugify to empty", () => {
    const base = makeBase();
    try {
      assert.throws(
        () => createDebugSession(base, { issue: "   " }),
        /Issue text is required/i,
      );

      assert.throws(
        () => slugifyDebugSessionIssue("🔥🔥🔥"),
        /alphanumeric/i,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("slugify normalizes unsupported characters into deterministic tokens", () => {
    assert.equal(
      slugifyDebugSessionIssue(" API / login 🚨 flaky  "),
      "api-login-flaky",
    );
  });

  test("invalid slug tokens are rejected for load/path validation", () => {
    const base = makeBase();
    try {
      assert.throws(() => assertValidDebugSessionSlug("../escape"), /Invalid debug session slug/);
      assert.throws(() => loadDebugSession(base, "../escape"), /Invalid debug session slug/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("create surfaces write failures and leaves no visible artifact", () => {
    const base = makeBase();
    try {
      assert.throws(
        () => createDebugSession(
          base,
          { issue: "Write failure case" },
          {
            atomicWrite: () => {
              throw new Error("simulated write failure");
            },
          },
        ),
        /simulated write failure/,
      );

      assert.equal(existsSync(debugSessionArtifactPath(base, "write-failure-case")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("creates sessions directory on first write boundary condition", () => {
    const base = makeBase();
    try {
      const dir = debugSessionsDir(base);
      assert.equal(existsSync(dir), false);

      createDebugSession(base, { issue: "First session" });
      assert.equal(existsSync(dir), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("debug-session-store: checkpoint and tddGate fields", () => {
  test("checkpoint round-trip: update with checkpoint, load, verify fields intact", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Checkpoint test" });

      const checkpoint: DebugCheckpoint = {
        type: "human-verify",
        summary: "OAuth redirect URL is misconfigured",
        awaitingResponse: true,
        userResponse: "The redirect URL points to staging, not production",
      };
      updateDebugSession(base, "checkpoint-test", { checkpoint });

      const loaded = loadDebugSession(base, "checkpoint-test");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.session.checkpoint, checkpoint);
      assert.equal(loaded.session.checkpoint?.type, "human-verify");
      assert.equal(loaded.session.checkpoint?.awaitingResponse, true);
      assert.equal(loaded.session.checkpoint?.userResponse, "The redirect URL points to staging, not production");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("tddGate round-trip: update with tddGate, load, verify fields intact", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "TDD gate test" });

      const tddGate: DebugTddGate = {
        enabled: true,
        phase: "red",
        testFile: "src/auth/oauth.test.ts",
        testName: "handles OAuth callback redirect",
        failureOutput: "Expected redirect to /dashboard, got /login",
      };
      updateDebugSession(base, "tdd-gate-test", { tddGate });

      const loaded = loadDebugSession(base, "tdd-gate-test");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.session.tddGate, tddGate);
      assert.equal(loaded.session.tddGate?.enabled, true);
      assert.equal(loaded.session.tddGate?.phase, "red");
      assert.equal(loaded.session.tddGate?.testFile, "src/auth/oauth.test.ts");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("null-clearing: update with checkpoint then null clears it", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Clear checkpoint test" });

      const checkpoint: DebugCheckpoint = {
        type: "decision",
        summary: "Needs design decision before continuing",
        awaitingResponse: false,
      };
      updateDebugSession(base, "clear-checkpoint-test", { checkpoint });

      // Verify it was set
      const withCheckpoint = loadDebugSession(base, "clear-checkpoint-test");
      assert.ok(withCheckpoint?.session.checkpoint !== null && withCheckpoint?.session.checkpoint !== undefined);

      // Clear it
      updateDebugSession(base, "clear-checkpoint-test", { checkpoint: null });

      const cleared = loadDebugSession(base, "clear-checkpoint-test");
      assert.ok(cleared !== null);
      assert.equal(cleared.session.checkpoint, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("backward compat: existing artifact without checkpoint/tddGate fields validates successfully", () => {
    const base = makeBase();
    try {
      // Write a minimal valid artifact that lacks checkpoint and tddGate — simulates S02 artifact
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "legacy-session",
        issue: "Legacy issue without new fields",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "legacy-session.log"),
        lastError: null,
      };
      writeFileSync(join(sessionsDir, "legacy-session.json"), JSON.stringify(artifact, null, 2), "utf-8");

      const loaded = loadDebugSession(base, "legacy-session");
      assert.ok(loaded !== null, "legacy artifact should load successfully");
      assert.equal(loaded.session.slug, "legacy-session");
      assert.equal(loaded.session.checkpoint, undefined);
      assert.equal(loaded.session.tddGate, undefined);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("validator rejects malformed checkpoint — missing required sub-fields", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      // checkpoint present but missing 'awaitingResponse'
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-checkpoint",
        issue: "Bad checkpoint",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "bad-checkpoint.log"),
        lastError: null,
        checkpoint: { type: "human-verify", summary: "Something" /* awaitingResponse missing */ },
      };
      writeFileSync(join(sessionsDir, "bad-checkpoint.json"), JSON.stringify(artifact, null, 2), "utf-8");

      assert.throws(
        () => loadDebugSession(base, "bad-checkpoint"),
        /Malformed debug session artifact/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("validator rejects malformed tddGate — missing required sub-fields", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      // tddGate present but missing 'enabled' and 'phase'
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-tddgate",
        issue: "Bad tddGate",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "bad-tddgate.log"),
        lastError: null,
        tddGate: { testFile: "some.test.ts" /* enabled and phase missing */ },
      };
      writeFileSync(join(sessionsDir, "bad-tddgate.json"), JSON.stringify(artifact, null, 2), "utf-8");

      assert.throws(
        () => loadDebugSession(base, "bad-tddgate"),
        /Malformed debug session artifact/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("debug-session-store: specialistReview field", () => {
  test("specialistReview round-trip: update with review, load, verify all fields intact", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Specialist review test" });

      const specialistReview: DebugSpecialistReview = {
        hint: "Check OAuth token expiry handling",
        skill: "auth-specialist",
        verdict: "SUGGEST_CHANGE (token refresh logic is missing)",
        detail: "The access token is never refreshed before expiry, causing silent auth failures.",
        reviewedAt: 1700000000,
      };
      updateDebugSession(base, "specialist-review-test", { specialistReview });

      const loaded = loadDebugSession(base, "specialist-review-test");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.session.specialistReview, specialistReview);
      assert.equal(loaded.session.specialistReview?.hint, "Check OAuth token expiry handling");
      assert.equal(loaded.session.specialistReview?.skill, "auth-specialist");
      assert.equal(loaded.session.specialistReview?.verdict, "SUGGEST_CHANGE (token refresh logic is missing)");
      assert.equal(loaded.session.specialistReview?.reviewedAt, 1700000000);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("specialistReview null-clear: update with review then null clears it", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Clear specialist review" });

      const specialistReview: DebugSpecialistReview = {
        hint: "Investigate DB connection pool",
        skill: null,
        verdict: "LOOKS_GOOD (no issue found)",
        detail: "Connection pool is sized correctly for the load profile.",
        reviewedAt: 1700000001,
      };
      updateDebugSession(base, "clear-specialist-review", { specialistReview });

      const withReview = loadDebugSession(base, "clear-specialist-review");
      assert.ok(withReview?.session.specialistReview !== null && withReview?.session.specialistReview !== undefined);

      updateDebugSession(base, "clear-specialist-review", { specialistReview: null });

      const cleared = loadDebugSession(base, "clear-specialist-review");
      assert.ok(cleared !== null);
      assert.equal(cleared.session.specialistReview, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("backward compat: existing artifact without specialistReview validates successfully", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "legacy-no-specialist",
        issue: "Legacy session without specialistReview",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "legacy-no-specialist.log"),
        lastError: null,
      };
      writeFileSync(join(sessionsDir, "legacy-no-specialist.json"), JSON.stringify(artifact, null, 2), "utf-8");

      const loaded = loadDebugSession(base, "legacy-no-specialist");
      assert.ok(loaded !== null, "legacy artifact should load successfully");
      assert.equal(loaded.session.specialistReview, undefined);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("validator rejects specialistReview with missing required fields (empty object)", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-specialist-empty",
        issue: "Bad specialist review",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "bad-specialist-empty.log"),
        lastError: null,
        specialistReview: {},
      };
      writeFileSync(join(sessionsDir, "bad-specialist-empty.json"), JSON.stringify(artifact, null, 2), "utf-8");

      assert.throws(
        () => loadDebugSession(base, "bad-specialist-empty"),
        /Malformed debug session artifact/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("validator rejects specialistReview with wrong field types (verdict as number, skill as number)", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-specialist-types",
        issue: "Bad specialist types",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "bad-specialist-types.log"),
        lastError: null,
        specialistReview: {
          hint: "Check something",
          skill: 42, // should be string|null
          verdict: 1, // should be string
          detail: "Some detail",
          reviewedAt: 1700000000,
        },
      };
      writeFileSync(join(sessionsDir, "bad-specialist-types.json"), JSON.stringify(artifact, null, 2), "utf-8");

      assert.throws(
        () => loadDebugSession(base, "bad-specialist-types"),
        /Malformed debug session artifact/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("validator accepts specialistReview with extra unknown fields (forward compat)", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "specialist-extra-fields",
        issue: "Specialist with extra fields",
        status: "active",
        phase: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        logPath: join(base, ".gsd", "debug", "specialist-extra-fields.log"),
        lastError: null,
        specialistReview: {
          hint: "Look at caching layer",
          skill: null,
          verdict: "LOOKS_GOOD (cache is correctly invalidated)",
          detail: "TTL is set appropriately.",
          reviewedAt: 1700000002,
          unknownFutureField: "some-value", // extra field should be tolerated
        },
      };
      writeFileSync(join(sessionsDir, "specialist-extra-fields.json"), JSON.stringify(artifact, null, 2), "utf-8");

      const loaded = loadDebugSession(base, "specialist-extra-fields");
      assert.ok(loaded !== null, "artifact with extra fields should load successfully");
      assert.equal(loaded.session.specialistReview?.hint, "Look at caching layer");
      assert.equal(loaded.session.specialistReview?.skill, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
