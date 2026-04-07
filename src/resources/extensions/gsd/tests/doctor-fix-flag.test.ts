/**
 * Regression test for #1919: --fix flag not stripped before positional parse.
 *
 * parseDoctorArgs("--fix") must:
 *   1. Set fixFlag = true
 *   2. Not leak "--fix" into requestedScope
 *   3. Keep mode as "doctor" (the flag is not a positional subcommand)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseDoctorArgs } from "../commands-handlers.js";

describe("#1919: --fix flag parsing in parseDoctorArgs", () => {
  describe("bare --fix flag", () => {
    test("sets fixFlag to true", () => {
      const r = parseDoctorArgs("--fix");
      assert.ok(r.fixFlag);
    });

    test("does not change mode from doctor", () => {
      const r = parseDoctorArgs("--fix");
      assert.deepStrictEqual(r.mode, "doctor");
    });

    test("is stripped and does not become requestedScope", () => {
      const r = parseDoctorArgs("--fix");
      assert.deepStrictEqual(r.requestedScope, undefined);
    });
  });

  describe("--fix with scope", () => {
    test("sets fixFlag to true", () => {
      const r = parseDoctorArgs("--fix M001/S01");
      assert.ok(r.fixFlag);
    });

    test("keeps mode as doctor", () => {
      const r = parseDoctorArgs("--fix M001/S01");
      assert.deepStrictEqual(r.mode, "doctor");
    });

    test("scope is M001/S01 after stripping --fix", () => {
      const r = parseDoctorArgs("--fix M001/S01");
      assert.deepStrictEqual(r.requestedScope, "M001/S01");
    });
  });

  describe("positional fix subcommand", () => {
    test("does not set fixFlag", () => {
      const r = parseDoctorArgs("fix");
      assert.deepStrictEqual(r.fixFlag, false);
    });

    test("sets mode to fix", () => {
      const r = parseDoctorArgs("fix");
      assert.deepStrictEqual(r.mode, "fix");
    });

    test("no scope with bare positional fix", () => {
      const r = parseDoctorArgs("fix");
      assert.deepStrictEqual(r.requestedScope, undefined);
    });
  });

  describe("positional fix with scope", () => {
    test("sets mode to fix", () => {
      const r = parseDoctorArgs("fix M001");
      assert.deepStrictEqual(r.mode, "fix");
    });

    test("parses scope as M001", () => {
      const r = parseDoctorArgs("fix M001");
      assert.deepStrictEqual(r.requestedScope, "M001");
    });
  });

  describe("--fix combined with other flags", () => {
    test("--fix --dry-run sets fixFlag", () => {
      const r = parseDoctorArgs("--fix --dry-run");
      assert.ok(r.fixFlag);
    });

    test("--fix --dry-run sets dryRun", () => {
      const r = parseDoctorArgs("--fix --dry-run");
      assert.ok(r.dryRun);
    });

    test("no scope leaked from combined flags", () => {
      const r = parseDoctorArgs("--fix --dry-run");
      assert.deepStrictEqual(r.requestedScope, undefined);
    });

    test("--fix --json sets fixFlag", () => {
      const r = parseDoctorArgs("--fix --json");
      assert.ok(r.fixFlag);
    });

    test("--fix --json sets jsonMode", () => {
      const r = parseDoctorArgs("--fix --json");
      assert.ok(r.jsonMode);
    });

    test("no scope leaked from --fix --json", () => {
      const r = parseDoctorArgs("--fix --json");
      assert.deepStrictEqual(r.requestedScope, undefined);
    });
  });

  describe("empty args baseline", () => {
    test("fixFlag false", () => {
      const r = parseDoctorArgs("");
      assert.deepStrictEqual(r.fixFlag, false);
    });

    test("mode is doctor", () => {
      const r = parseDoctorArgs("");
      assert.deepStrictEqual(r.mode, "doctor");
    });

    test("no scope", () => {
      const r = parseDoctorArgs("");
      assert.deepStrictEqual(r.requestedScope, undefined);
    });
  });

  describe("heal and audit modes", () => {
    test("heal mode parsed correctly", () => {
      const rh = parseDoctorArgs("heal M001/S01");
      assert.deepStrictEqual(rh.mode, "heal");
    });

    test("heal scope parsed correctly", () => {
      const rh = parseDoctorArgs("heal M001/S01");
      assert.deepStrictEqual(rh.requestedScope, "M001/S01");
    });

    test("audit mode parsed correctly", () => {
      const ra = parseDoctorArgs("audit");
      assert.deepStrictEqual(ra.mode, "audit");
    });
  });
});
